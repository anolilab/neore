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
import { checkDueTasks, claimRound, completeRound, recordRunNotice, runProjectFor, runThreadProblem } from "./internal";
import { MAX_RECURRENCES_PER_USER_PER_SWEEP } from "./logic";

// `user` is a `.global()` (D1) table the in-memory harness cannot write, so the
// account behind each claim is looked up here instead.
const { users } = vi.hoisted(() => {
    return { users: new Map<string, { isAnonymous?: boolean; role?: string }>() };
});

// `projects` is a `.global()` table too: which projects the owner may file into, and their context, is set here.
const { readableProjects } = vi.hoisted(() => {
    return { readableProjects: new Map<string, { context?: string }>() };
});

vi.mock("../projects/functions", () => {
    const found = async (_ctx: unknown, projectId: string) => {
        const project = readableProjects.get(projectId);

        return project ? { _id: projectId, ...project } : null;
    };

    return { readableProject: found, writableProject: found };
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

const getTask = async (id: string): Promise<any> =>
    await harness.run(async (ctx: any) => (await ctx.db.get("tasks", id as never)) ?? (await ctx.db.get("taskRuns", id as never)));

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
    readableProjects.clear();
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
                // A new thread per round has no history: the round is given the attempt it repairs.
                expect(claimed.repair).toStrictEqual({ previousAnswer: "draft", reasons: FAIL.reasons, repairInstructions: FAIL.repairInstructions });
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

    it("stops a recurring task's schedule on an error no later round can cure, keeping the schedule itself", async () => {
        const taskId = await insertTask({ activeCycle: "c1", cronExpression: "0 9 * * *", nextRunAt: 1000, recurring: true, status: "queued" });
        const claimed = await claim(taskId, 0);

        expect(await complete({ outcome: { error: "You left.", kind: "error", stopsRecurrence: true }, runId: claimed.runId })).toBe("failed");

        const task = await getTask(taskId);

        expect(task).toMatchObject({ cronExpression: "0 9 * * *", lastError: "You left.", status: "failed" });
        expect("nextRunAt" in task).toBe(false);
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
        await harness.run(async (ctx: any) => await patchById(ctx.db, "tasks", taskId as never, { activeCycle: undefined, status: "todo" }));

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
        expect(busyTask.updatedAt).toBe(1);
        expect(roundJobs().map((job) => job.args)).toStrictEqual([expect.objectContaining({ origin: "schedule", taskId: due })]);
    });

    it("fails a round that stopped reporting", async () => {
        const taskId = await insertTask({ activeCycle: "c1", status: "queued", updatedAt: 1 });
        const claimed = await claim(taskId, 0);

        await harness.run(async (ctx: any) => await ctx.db.patch("tasks", taskId, { updatedAt: 1 }));
        await runInternal(checkDueTasks, {});

        const task = await getTask(taskId);

        expect(task.status).toBe("failed");
        expect(task.activeCycle ?? undefined).toBeUndefined();
        expect(await statusOf(claimed.runId)).toBe("error");
    });
});

describe("checkDueTasks missed and overlapping slots", () => {
    const HOUR = 60 * 60_000;
    const HOURLY = "0 * * * *";

    // Half past an hour, so no test here sees the clock cross an hourly slot between its setup and its sweep.
    beforeEach(() => {
        vi.useFakeTimers({ now: Date.UTC(2026, 10, 6, 12, 30), toFake: ["Date"] });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("starts exactly one catch-up run after a three-slot outage, then waits for the next future slot", async () => {
        const taskId = await insertTask({ cronExpression: HOURLY, nextRunAt: Date.now() - 3 * HOUR, recurring: true, status: "done" });

        await runInternal(checkDueTasks, {});

        expect(roundJobs()).toHaveLength(1);
        const task = await getTask(taskId);

        expect(task.status).toBe("queued");
        expect(task.nextRunAt).toBeGreaterThan(Date.now());
        expect(task.lastSkippedAt).toBeUndefined();

        // The catch-up finished at once; the next sweeps start nothing until the next slot.
        await harness.run(async (ctx: any) => await patchById(ctx.db, "tasks", taskId as never, { activeCycle: undefined, status: "done" }));
        await runInternal(checkDueTasks, {});
        await runInternal(checkDueTasks, {});

        expect(roundJobs()).toHaveLength(1);
    });

    it("fails a round that went silent during the outage before the slot, so the slot starts the catch-up", async () => {
        const taskId = await insertTask({
            activeCycle: "stuck",
            cronExpression: HOURLY,
            nextRunAt: Date.now() - 3 * HOUR,
            recurring: true,
            status: "running",
            updatedAt: Date.now() - 4 * HOUR,
        });

        await runInternal(checkDueTasks, {});

        const task = await getTask(taskId);

        expect(task.status).toBe("queued");
        expect(task.lastSkipReason).toBeUndefined();
        expect(roundJobs()).toHaveLength(1);
    });

    it("fails a dead round past the stale batch when its slot comes up, and starts the catch-up", async () => {
        const fourHoursAgo = Date.now() - 4 * HOUR;

        // More dead rounds than one stale batch fails, all older than the recurring one.
        for (let index = 0; index < 30; index += 1) {
            await insertTask({ activeCycle: `old-${String(index)}`, status: "running", title: `Old ${String(index)}`, updatedAt: fourHoursAgo - 1000 + index });
        }

        const taskId = await insertTask({
            activeCycle: "stuck",
            cronExpression: HOURLY,
            nextRunAt: Date.now() - 3 * HOUR,
            recurring: true,
            status: "running",
            updatedAt: fourHoursAgo,
        });

        await runInternal(checkDueTasks, {});

        const task = await getTask(taskId);

        expect(task.status).toBe("queued");
        expect(task.lastSkipReason).toBeUndefined();
        expect(roundJobs().map((job) => job.args.taskId)).toStrictEqual([taskId]);
    });

    it("keeps a trace of a round that never started, though the catch-up re-queues the task at once", async () => {
        const taskId = await insertTask({
            activeCycle: "lost",
            cronExpression: HOURLY,
            nextRunAt: Date.now() - HOUR,
            recurring: true,
            status: "queued",
            updatedAt: Date.now() - 2 * HOUR,
        });

        await runInternal(checkDueTasks, {});

        expect(await statusOf(taskId)).toBe("queued");
        expect(await inbox()).toStrictEqual([{ outcome: "failure", title: "Summary", type: "task" }]);
    });

    it("never lets a skipped task hold up the next due task in the batch", async () => {
        // A schedule that matches no date (30 February), skipped while it runs.
        const impossible = await insertTask({
            activeCycle: "c1",
            createdAt: Date.now() - 400 * 24 * HOUR,
            cronExpression: "0 0 30 2 *",
            nextRunAt: Date.now() - 300 * 24 * HOUR,
            recurring: true,
            status: "running",
            title: "Impossible",
            updatedAt: Date.now() - 60_000,
        });
        const next = await insertTask({ cronExpression: HOURLY, nextRunAt: Date.now() - HOUR, recurring: true, status: "done", title: "Next" });
        const started = performance.now();

        await runInternal(checkDueTasks, {});

        expect(performance.now() - started).toBeLessThan(5000);
        expect(roundJobs().map((job) => job.args.taskId)).toStrictEqual([next]);

        const skipped = await getTask(impossible);

        expect(skipped.status).toBe("running");
        expect(skipped.nextRunAt).toBeGreaterThan(Date.now());
        expect(skipped.lastSkippedAt).toBeUndefined();
    });

    it("records the first slot of a task found blocked like any later skipped slot", async () => {
        const slot = Math.floor(Date.now() / HOUR) * HOUR;
        const dependency = await insertTask({ title: "Dependency" });
        const taskId = await insertTask({ cronExpression: HOURLY, dependsOn: [dependency], nextRunAt: slot, recurring: true, status: "todo" });

        await runInternal(checkDueTasks, {});

        expect(await getTask(taskId)).toMatchObject({ lastSkippedAt: slot, lastSkipReason: "blocked", status: "blocked" });
        expect(roundJobs()).toHaveLength(0);
    });

    it("records no slot from before the task was created", async () => {
        const latest = Math.floor(Date.now() / HOUR) * HOUR;
        const taskId = await insertTask({
            createdAt: latest - 90 * 60_000,
            cronExpression: HOURLY,
            nextRunAt: latest - 5 * HOUR,
            recurring: true,
            status: "needs_review",
        });

        await runInternal(checkDueTasks, {});

        const task = await getTask(taskId);

        expect(task.lastSkippedAt).toBe(latest);
        expect(task.lastSkippedAt).toBeGreaterThanOrEqual(task.createdAt);
    });

    it("records a slot that falls while the previous run is still going, without touching updatedAt", async () => {
        const slot = Math.floor(Date.now() / HOUR) * HOUR;
        const lastSignOfLife = Date.now() - 5 * 60_000;
        const taskId = await insertTask({
            activeCycle: "c1",
            cronExpression: HOURLY,
            nextRunAt: slot,
            recurring: true,
            status: "running",
            updatedAt: lastSignOfLife,
        });

        await runInternal(checkDueTasks, {});

        const task = await getTask(taskId);

        expect(task).toMatchObject({ activeCycle: "c1", lastSkippedAt: slot, lastSkipReason: "still_running", status: "running", updatedAt: lastSignOfLife });
        expect(task.nextRunAt).toBeGreaterThan(Date.now());
        expect(roundJobs()).toHaveLength(0);
    });

    it("records the latest of the slots missed while the last result waits on a review", async () => {
        const latest = Math.floor(Date.now() / HOUR) * HOUR;
        const taskId = await insertTask({ cronExpression: HOURLY, nextRunAt: latest - 3 * HOUR, recurring: true, status: "needs_review" });

        await runInternal(checkDueTasks, {});

        expect(await getTask(taskId)).toMatchObject({ lastSkippedAt: latest, lastSkipReason: "awaiting_review", status: "needs_review" });
    });
});

describe("a failed run", () => {
    it("shows failed, keeps no earlier result as its own, and notifies a failure", async () => {
        const taskId = await insertTask({ activeCycle: "c1", resultSummary: "Yesterday's summary", status: "queued" });
        const claimed = await claim(taskId, 0);

        expect(await complete({ outcome: { error: "The provider is down.", kind: "error" }, runId: claimed.runId, threadId: "thread-2" })).toBe("failed");

        const task = await getTask(taskId);

        expect(task).toMatchObject({ lastError: "The provider is down.", lastRunThreadId: "thread-2", status: "failed" });
        expect(task.resultSummary).toBeUndefined();
        expect(await statusOf(claimed.runId)).toBe("error");
        expect(await inbox()).toStrictEqual([expect.objectContaining({ outcome: "failure", type: "task" })]);
    });

    it("drops an earlier result when a stale round is failed", async () => {
        const taskId = await insertTask({ activeCycle: "c1", resultSummary: "Yesterday's summary", status: "queued", updatedAt: 1 });

        await runInternal(checkDueTasks, {});

        const task = await getTask(taskId);

        expect(task.status).toBe("failed");
        expect(task.resultSummary).toBeUndefined();
    });
});

describe("claimRound destination and effort", () => {
    const insertThread = async (fields: Record<string, unknown> = {}): Promise<string> =>
        await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "Task: Summary", userId: USER, ...fields }));

    it("continues run 1's thread on run 2 of a recurring task set to continue, with the task's effort", async () => {
        const thread = await insertThread();
        const taskId = await insertTask({
            activeCycle: "c1",
            cronExpression: "0 9 * * *",
            lastRunThreadId: thread,
            reasoningEffort: 75,
            recurring: true,
            runDestination: "continue_thread",
            status: "queued",
        });

        const claimed = await claim(taskId, 0);

        expect(claimed).toMatchObject({ continueThreadId: thread, reasoningEffort: 75 });
        expect(claimed.freshContext).toBeUndefined();
    });

    it("asks for a fresh context on a task set to one thread with a fresh context per run", async () => {
        const thread = await insertThread();
        const taskId = await insertTask({
            activeCycle: "c1",
            cronExpression: "0 9 * * *",
            lastRunThreadId: thread,
            recurring: true,
            runDestination: "fresh_context",
            status: "queued",
        });

        expect(await claim(taskId, 0)).toMatchObject({ contextDivider: true, continueThreadId: thread, freshContext: true });
    });

    it("starts a new thread after the task moved to another project", async () => {
        readableProjects.set("project-new", {});

        const thread = await insertThread({ projectId: "project-old" });
        const taskId = await insertTask({
            activeCycle: "c1",
            cronExpression: "0 9 * * *",
            lastRunThreadId: thread,
            projectId: "project-new",
            recurring: true,
            runDestination: "continue_thread",
            status: "queued",
        });

        const claimed = await claim(taskId, 0);

        expect(claimed.continueThreadId).toBeUndefined();
        expect(claimed.projectId).toBe("project-new");
    });

    it("gives the run the project's own instructions, re-read right before the run, and nothing once access is gone", async () => {
        readableProjects.set("project-a", { context: "Write for the finance team." });

        const taskId = await insertTask({ activeCycle: "c1", projectId: "project-a", status: "queued" });
        const runProject = async (): Promise<unknown> => await harness.run(async (ctx: any) => await ctx.runQuery(runProjectFor, { taskId }));

        expect(await claim(taskId, 0)).toMatchObject({ projectId: "project-a" });
        expect(await runProject()).toStrictEqual({ context: "Write for the finance team.", projectId: "project-a" });

        // The owner left the project's organization between the claim and the run.
        readableProjects.delete("project-a");
        expect(await runProject()).toBeNull();
    });

    it("continues a repair round in the thread its cycle's previous round ran in", async () => {
        const kept = await insertThread();
        const fallback = await insertThread();
        const taskId = await insertTask({
            activeCycle: "c1",
            cronExpression: "0 9 * * *",
            lastRunThreadId: kept,
            recurring: true,
            runDestination: "continue_thread",
            status: "running",
        });

        // Round 0 fell back to a new chat (the kept one was busy) and did not pass the verifier.
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("taskRuns", {
                    cycle: "c1",
                    origin: "schedule",
                    round: 0,
                    startedAt: 1,
                    status: "failed",
                    taskId,
                    threadId: fallback,
                    userId: USER,
                }),
        );

        const claimed = await claim(taskId, 1);

        expect(claimed.continueThreadId).toBe(fallback);

        // Completing the repair in the fallback thread leaves the task on its kept thread.
        await complete({
            keepLastThread: claimed.keepLastThread,
            outcome: { finalAnswer: "Fixed", kind: "verified", verdict: PASS },
            runId: claimed.runId,
            threadId: fallback,
        });
        expect(await getTask(taskId)).toMatchObject({ lastRunThreadId: kept, status: "done" });
    });

    it("gives a fresh-context repair round the attempt it repairs, which its context does not hold", async () => {
        const thread = await insertThread();
        const taskId = await insertTask({
            activeCycle: "c1",
            cronExpression: "0 9 * * *",
            lastRunThreadId: thread,
            recurring: true,
            runDestination: "fresh_context",
            status: "running",
        });

        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("taskRuns", {
                    cycle: "c1",
                    finalAnswer: "Draft one",
                    origin: "schedule",
                    round: 0,
                    startedAt: 1,
                    status: "failed",
                    taskId,
                    threadId: thread,
                    userId: USER,
                    verdict: FAIL,
                }),
        );

        const claimed = await claim(taskId, 1);

        expect(claimed).toMatchObject({ freshContext: true, repair: { previousAnswer: "Draft one", reasons: FAIL.reasons } });
    });

    it("starts a new thread instead of writing into a locked chat, and records why", async () => {
        const thread = await insertThread({ lockedAt: 1 });
        const taskId = await insertTask({
            activeCycle: "c1",
            cronExpression: "0 9 * * *",
            lastRunThreadId: thread,
            recurring: true,
            runDestination: "continue_thread",
            status: "queued",
        });

        const claimed = await claim(taskId, 0);
        const task = await getTask(taskId);

        expect(claimed.continueThreadId).toBeUndefined();
        expect(claimed.keepLastThread).toBe(true);
        expect(task.lastRunNotice).toMatchObject({ reason: "thread_locked" });
    });

    it("keeps the task's thread when a run fell back for a passing reason, and hands over otherwise", async () => {
        const keep = await insertTask({ activeCycle: "c1", lastRunThreadId: "thread-kept", status: "queued" });
        const kept = await claim(keep, 0);

        await complete({
            keepLastThread: true,
            outcome: { finalAnswer: "Done", kind: "verified", verdict: PASS },
            runId: kept.runId,
            threadId: "thread-fallback",
        });
        expect(await getTask(keep)).toMatchObject({ lastRunThreadId: "thread-kept", status: "done" });

        const hand = await insertTask({ activeCycle: "c2", lastRunThreadId: "thread-gone", status: "queued" });
        const handed = await claim(hand, 0, "c2");

        await complete({ outcome: { finalAnswer: "Done", kind: "verified", verdict: PASS }, runId: handed.runId, threadId: "thread-new" });
        expect(await getTask(hand)).toMatchObject({ lastRunThreadId: "thread-new" });
    });

    it("keeps a cancelled round's late action out of the kept thread, which may be the newer cycle's", async () => {
        const thread = await insertThread();
        const taskId = await insertTask({
            activeCycle: "c-new",
            cronExpression: "0 9 * * *",
            lastRunThreadId: thread,
            recurring: true,
            runDestination: "continue_thread",
            status: "running",
        });
        const problem = async (cycle: string): Promise<unknown> =>
            await harness.run(async (ctx: any) => await ctx.runQuery(runThreadProblem, { cycle, round: 0, taskId, threadId: thread }));

        expect(await problem("c-old")).toBe("thread_unavailable");
        expect(await problem("c-new")).toBeNull();
    });

    it("never lets a cancelled round's late action overwrite a newer run's notice", async () => {
        const taskId = await insertTask({ activeCycle: "c-new", lastRunNotice: { at: 1, reason: "project_unwritable" }, status: "running" });

        await runInternal(recordRunNotice, { cycle: "c-old", reason: "thread_busy", taskId });
        expect(await getTask(taskId)).toMatchObject({ lastRunNotice: { reason: "project_unwritable" } });

        await runInternal(recordRunNotice, { cycle: "c-new", reason: "thread_busy", taskId });
        expect(await getTask(taskId)).toMatchObject({ lastRunNotice: { reason: "thread_busy" } });
    });

    it("keeps the notice of the run's first round through a repair round", async () => {
        const taskId = await insertTask({
            activeCycle: "c1",
            lastRunNotice: { at: 1, reason: "thread_locked" },
            status: "running",
        });

        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("taskRuns", { cycle: "c1", origin: "schedule", round: 0, startedAt: 1, status: "failed", taskId, userId: USER }),
        );
        const claimed = await claim(taskId, 1);
        const task = await getTask(taskId);

        expect(claimed).not.toBeNull();
        expect(task.lastRunNotice).toMatchObject({ reason: "thread_locked" });
    });

    it("files nothing in a project the owner can no longer read, and leaves its thread", async () => {
        const thread = await insertThread({ projectId: "project-left" });
        const taskId = await insertTask({
            activeCycle: "c1",
            cronExpression: "0 9 * * *",
            lastRunThreadId: thread,
            projectId: "project-left",
            recurring: true,
            runDestination: "continue_thread",
            status: "queued",
        });

        const claimed = await claim(taskId, 0);

        expect(claimed.projectId).toBeUndefined();
        expect(claimed.continueThreadId).toBeUndefined();

        const task = await getTask(taskId);

        expect(task.lastRunNotice).toMatchObject({ reason: "project_unwritable" });
    });

    it("starts a new thread each run by default", async () => {
        const thread = await insertThread();
        const taskId = await insertTask({ activeCycle: "c1", cronExpression: "0 9 * * *", lastRunThreadId: thread, recurring: true, status: "queued" });

        const claimed = await claim(taskId, 0);

        expect(claimed.continueThreadId).toBeUndefined();
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
