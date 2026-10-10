/**
 * The runner's state machine against a real (in-memory) database: claims are
 * idempotent, the repair loop stops at its cap, completion unblocks dependents,
 * a cancelled cycle's late result is discarded, and the minute tick re-queues
 * due recurrences — fairly across users — and fails stale rounds. A claim is
 * refused for an account being deleted, an anonymous account, a model no longer
 * allowed and a spent daily limit.
 *
 * Scheduled jobs are only inspected, never run — `runTaskRound` would call a model.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { patchById } from "../lib/patch";
import schema from "../schema";
import { jobsQueueMessages } from "../../test/stubs/cloudflare-workers";
import { DAILY_LIMIT_MESSAGE, ANONYMOUS_TASKS_MESSAGE } from "./account";
import { checkDueTasks, claimRound, completeRound } from "./internal";
import { MAX_RECURRENCES_PER_USER_PER_SWEEP } from "./logic";

// `user` is a `.global()` (D1) table the in-memory harness cannot write, so the
// account behind each claim is looked up here instead.
const { users } = vi.hoisted(() => {
    return { users: new Map<string, { isAnonymous?: boolean; role?: string }>() };
});

vi.mock("../auth/lib/better-auth-queries", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth/lib/better-auth-queries")>()),
        getUser: async (_ctx: unknown, userId: string) => {
            const user = users.get(userId);

            return user ? { _id: userId, ...user } : null;
        },
    };
});

type Harness = ReturnType<typeof lunoraTest>;

const USER = "user-a";
const UNVERIFIED_RE = /verification could not run/u;
const MODEL_GONE_RE = /no longer available/u;
const FAIL = { pass: false, reasons: ["Missing the summary"], repairInstructions: "Add a summary" };
const PASS = { pass: true, reasons: ["All criteria met"] };

let harness: Harness;

const insertTask = async (overrides: Record<string, unknown> = {}): Promise<string> =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("tasks", {
                attemptCount: 0,
                createdAt: 1,
                dependsOn: [],
                instructions: "Summarise the report",
                maxRepairRounds: 2,
                recurring: false,
                status: "todo",
                title: "Summary",
                updatedAt: 1,
                userId: USER,
                ...overrides,
            }),
    );

const getTask = async (id: string): Promise<any> => await harness.run(async (ctx: any) => await ctx.db.get(id));

/** The owner's inbox (`notifications/notify.ts`), as type/outcome/title. */
const inbox = async (): Promise<{ outcome?: string; title: string; type: string }[]> =>
    await harness.run(async (ctx: any) => {
        const rows = await ctx.db.query("notifications").collect();

        return rows
            .filter((row: any) => row.userId === USER)
            .map(({ outcome, title, type }: any) => {
                return { outcome, title, type };
            });
    });

const statusOf = async (id: string): Promise<string> => await getTask(id).then((row) => row.status);

/** Rounds go on the jobs queue, not the scheduler (`lib/job-queue.ts`); the test stub records them. */
const roundJobs = (): { args: Record<string, unknown> }[] =>
    jobsQueueMessages
        .filter((message) => message.body.functionPath.includes("runTaskRound"))
        .map((message) => {
            return { args: message.body.args ?? {} };
        });

/** Internal procedures are unreachable from the harness's RPC boundary; call them the way the runner does. */
const runInternal = async (reference: unknown, args: Record<string, unknown>): Promise<any> =>
    await harness.run(async (ctx: any) => await ctx.runMutation(reference, args));

const claim = async (taskId: string, round: number, cycle = "c1"): Promise<any> => await runInternal(claimRound, { cycle, origin: "manual", round, taskId });

const complete = async (args: Record<string, unknown>): Promise<unknown> => await runInternal(completeRound, args);

const verified = (runId: string, finalAnswer: string, verdict: typeof FAIL | typeof PASS, threadId?: string): Promise<unknown> =>
    complete({ outcome: { finalAnswer, kind: "verified", verdict }, runId, ...(threadId && { threadId }) });

beforeEach(() => {
    jobsQueueMessages.length = 0;
    harness = lunoraTest(schema as never);
    users.clear();
    users.set(USER, {});
});

afterEach(() => {
    harness.close();
});

describe("claimRound", () => {
    it("claims a queued round once and refuses a duplicate or a stale cycle", async () => {
        const taskId = await insertTask({ activeCycle: "c1", status: "queued" });

        const first = await claim(taskId, 0);

        expect(first).toMatchObject({ instructions: "Summarise the report", title: "Summary", userId: USER });
        expect(await claim(taskId, 0)).toBeNull();
        expect(await claim(taskId, 0, "other-cycle")).toBeNull();

        const task = await getTask(taskId);

        expect(task.status).toBe("running");
        expect(task.attemptCount).toBe(1);
    });

    it("refuses a task that is not queued", async () => {
        const taskId = await insertTask({ activeCycle: "c1", status: "todo" });

        expect(await claim(taskId, 0)).toBeNull();
    });
});

describe("repair loop", () => {
    it("repairs with the verifier's feedback up to the cap, then asks for review", async () => {
        const taskId = await insertTask({ activeCycle: "c1", maxRepairRounds: 2, status: "queued" });

        for (const round of [0, 1]) {
            const claimed = await claim(taskId, round);

            if (round > 0) {
                expect(claimed.repair).toStrictEqual({ reasons: FAIL.reasons, repairInstructions: FAIL.repairInstructions });
            }

            expect(await verified(claimed.runId, "draft", FAIL, `t${String(round)}`)).toBe("repair");
            expect(roundJobs().at(-1)?.args).toMatchObject({ cycle: "c1", origin: "repair", round: round + 1, taskId });
        }

        const last = await claim(taskId, 2);

        expect(await verified(last.runId, "draft", FAIL, "t2")).toBe("needs_review");

        const task = await getTask(taskId);

        expect(task.status).toBe("needs_review");
        expect(task.activeCycle ?? undefined).toBeUndefined();
        expect(task.attemptCount).toBe(3);
        expect(task.lastRunThreadId).toBe("t2");
        expect(roundJobs()).toHaveLength(2);

        // A retried completion of an already-finished run is a no-op.
        expect(await verified(last.runId, "late", PASS)).toBeNull();
        expect(await statusOf(taskId)).toBe("needs_review");
    });

    it("skips repairs when the verifier itself could not run, and records no verdict", async () => {
        const taskId = await insertTask({ activeCycle: "c1", status: "queued" });
        const claimed = await claim(taskId, 0);

        expect(await complete({ outcome: { finalAnswer: "answer", kind: "unverified" }, runId: claimed.runId })).toBe("needs_review");
        expect(roundJobs()).toHaveLength(0);

        const run = await getTask(claimed.runId);

        expect(run).toMatchObject({ finalAnswer: "answer", status: "error" });
        expect(run.error).toMatch(UNVERIFIED_RE);
        expect("verdict" in run).toBe(false);
        expect(await getTask(taskId)).toMatchObject({ resultSummary: "answer", status: "needs_review" });
    });

    it("fails the task on a run error", async () => {
        const taskId = await insertTask({ activeCycle: "c1", status: "queued" });
        const claimed = await claim(taskId, 0);

        expect(await complete({ outcome: { error: "The agent run failed.", kind: "error" }, runId: claimed.runId })).toBe("failed");

        const task = await getTask(taskId);

        expect(task.status).toBe("failed");
        expect(task.lastError).toBe("The agent run failed.");
        expect(await inbox()).toStrictEqual([{ outcome: "failure", title: "Summary", type: "task" }]);
    });
});

describe("completion", () => {
    it("marks the task done and queues a dependent whose last dependency this was", async () => {
        const first = await insertTask({ activeCycle: "c1", status: "queued" });
        const other = await insertTask({ status: "running", title: "Other" });
        const ready = await insertTask({ dependsOn: [first], status: "blocked", title: "Ready" });
        const waiting = await insertTask({ dependsOn: [first, other], status: "blocked", title: "Waiting" });

        const claimed = await claim(first, 0);

        expect(await verified(claimed.runId, "The summary.", PASS)).toBe("done");

        expect(await getTask(first)).toMatchObject({ resultSummary: "The summary.", status: "done" });
        const readyTask = await getTask(ready);

        expect(readyTask.status).toBe("queued");
        expect(readyTask.activeCycle).toEqual(expect.any(String));
        expect(await statusOf(waiting)).toBe("blocked");
        expect(roundJobs().map((job) => job.args.taskId)).toStrictEqual([ready]);
        expect(await inbox()).toStrictEqual([{ outcome: "success", title: "Summary", type: "task" }]);
    });

    it("discards a result that arrives after the cycle was cancelled", async () => {
        const taskId = await insertTask({ activeCycle: "c1", status: "queued" });
        const claimed = await claim(taskId, 0);

        // What `cancelTask` does.
        await harness.run(async (ctx: any) => await patchById(ctx.db, taskId, { activeCycle: undefined, status: "todo" }));

        expect(await verified(claimed.runId, "late", PASS)).toBe("cancelled");
        expect(await statusOf(taskId)).toBe("todo");
    });
});

describe("checkDueTasks", () => {
    it("re-queues a due recurring task at rest and advances its next run", async () => {
        const due = await insertTask({ cronExpression: "0 9 * * *", nextRunAt: 1000, recurring: true, status: "done" });
        const busy = await insertTask({ cronExpression: "0 9 * * *", nextRunAt: 1000, recurring: true, status: "needs_review" });

        await runInternal(checkDueTasks, {});

        const dueTask = await getTask(due);

        expect(dueTask.status).toBe("queued");
        expect(dueTask.nextRunAt).toBeGreaterThan(Date.now());
        const busyTask = await getTask(busy);

        expect(busyTask.status).toBe("needs_review");
        expect(busyTask.nextRunAt).toBeGreaterThan(Date.now());
        expect(roundJobs().map((job) => job.args)).toStrictEqual([expect.objectContaining({ origin: "schedule", taskId: due })]);
    });

    it("fails a round that stopped reporting", async () => {
        const taskId = await insertTask({ activeCycle: "c1", status: "queued", updatedAt: 1 });
        const claimed = await claim(taskId, 0);

        await harness.run(async (ctx: any) => await ctx.db.patch(taskId, { updatedAt: 1 }));
        await runInternal(checkDueTasks, {});

        const task = await getTask(taskId);

        expect(task.status).toBe("failed");
        expect(task.activeCycle ?? undefined).toBeUndefined();
        expect(await statusOf(claimed.runId)).toBe("error");
    });
});

describe("claim refusals", () => {
    const runCount = async (): Promise<number> => {
        const runs: unknown[] = await harness.run(async (ctx: any) => await ctx.db.query("taskRuns").collect());

        return runs.length;
    };

    it("drops the cycle without running while the account is being deleted", async () => {
        const taskId = await insertTask({ activeCycle: "c1", status: "queued" });

        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("gdprRequests", {
                    requestedAt: 1,
                    requestType: "deletion",
                    status: "processing",
                    userEmail: "a@example.com",
                    userId: USER,
                }),
        );

        expect(await claim(taskId, 0)).toBeNull();
        expect(await runCount()).toBe(0);

        const task = await getTask(taskId);

        expect(task.status).toBe("todo");
        expect(task.activeCycle ?? undefined).toBeUndefined();
    });

    it("still runs after a deletion request that failed or was cancelled", async () => {
        const taskId = await insertTask({ activeCycle: "c1", status: "queued" });

        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("gdprRequests", { requestedAt: 1, requestType: "deletion", status: "cancelled", userEmail: "a@example.com", userId: USER }),
        );

        expect(await claim(taskId, 0)).not.toBeNull();
    });

    it("fails the task for an anonymous account", async () => {
        users.set(USER, { isAnonymous: true });

        const taskId = await insertTask({ activeCycle: "c1", status: "queued" });

        expect(await claim(taskId, 0)).toBeNull();
        expect(await runCount()).toBe(0);
        expect(await getTask(taskId)).toMatchObject({ lastError: ANONYMOUS_TASKS_MESSAGE, status: "failed" });
    });

    it("fails the task when its model is not one the picker offers", async () => {
        const taskId = await insertTask({ activeCycle: "c1", model: "not-a-registry-model", status: "queued" });

        expect(await claim(taskId, 0)).toBeNull();
        const task = await getTask(taskId);

        expect(task.status).toBe("failed");
        expect(task.lastError).toMatch(MODEL_GONE_RE);
    });

    it("charges every round to the daily limits and refuses once they are spent", async () => {
        // `tasks/dailyRuns:free` is the tighter of the two for a free account.
        const limit = 10;
        let claimed = 0;

        for (let index = 0; index <= limit; index += 1) {
            const taskId = await insertTask({ activeCycle: `c${String(index)}`, status: "queued" });

            if (await claim(taskId, 0, `c${String(index)}`)) {
                claimed += 1;
            } else {
                expect(await getTask(taskId)).toMatchObject({ lastError: DAILY_LIMIT_MESSAGE, status: "failed" });
            }
        }

        expect(claimed).toBe(limit);
        expect(await runCount()).toBe(limit);
    });

    it("does not charge an admin", async () => {
        users.set(USER, { role: "admin" });

        for (let index = 0; index < 12; index += 1) {
            const taskId = await insertTask({ activeCycle: `c${String(index)}`, status: "queued" });

            expect(await claim(taskId, 0, `c${String(index)}`)).not.toBeNull();
        }
    });
});

describe("checkDueTasks fairness", () => {
    it("caps each user per sweep, so one user's backlog cannot starve another", async () => {
        users.set("user-b", {});

        // User A's tasks are all due EARLIER than user B's one.
        for (let index = 0; index < 10; index += 1) {
            await insertTask({ cronExpression: "0 9 * * *", nextRunAt: 100 + index, recurring: true, status: "done", title: `A${String(index)}` });
        }

        const other = await insertTask({ cronExpression: "0 9 * * *", nextRunAt: 5000, recurring: true, status: "done", userId: "user-b" });

        await runInternal(checkDueTasks, {});

        const started = roundJobs().map((job) => job.args.taskId);

        expect(started).toContain(other);
        expect(started).toHaveLength(MAX_RECURRENCES_PER_USER_PER_SWEEP + 1);

        // The ones left over are still due, so the next sweep serves them.
        const rows: any[] = await harness.run(async (ctx: any) => await ctx.db.query("tasks").collect());
        const leftOver = rows.filter((task) => task.userId === USER && task.status === "done");

        expect(leftOver).toHaveLength(10 - MAX_RECURRENCES_PER_USER_PER_SWEEP);
        expect(leftOver.every((task: any) => task.nextRunAt < 1000)).toBe(true);
    });
});
