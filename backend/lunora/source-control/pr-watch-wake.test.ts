/**
 * The wake turn (`pr-watch-wake.ts`): the scheduled step claims, commits, and only then enqueues; the job charges a round right before
 * the turn, runs it, and only then the wake is counted and the delivered occurrences cleared. A failed or over-limit turn leaves the reasons pending. The agent run,
 * the jobs queue and the daily charge are faked; claim, finish and the poller's record are the real procedures.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { insertThread } from "../agent/table-writes";
import schema from "../schema";
import { PR_WATCH_MAX_WAKES, PR_WATCH_WAKE_COOLDOWN_MS } from "./pr-watch-logic";
import { setPullRequestWatch } from "./pr-watch";

const { enqueued, probe, registry, runs } = vi.hoisted(() => {
    return {
        enqueued: [] as { args: Record<string, any>; options: Record<string, any> }[],
        probe: {
            allowRound: true,
            anonymous: false,
            charges: 0,
            during: undefined as (() => Promise<void>) | undefined,
            enqueueFails: false,
            fail: false,
            failBeforeModel: false,
            failWith: undefined as unknown,
            leaseSeenAtEnqueue: undefined as number | undefined,
            readLease: undefined as ((linkId: string) => Promise<number | undefined>) | undefined,
            refundedKeys: [] as string[][],
            refunds: 0,
            tier: "premium" as "free" | "premium",
        },
        registry: new Map<string, unknown>(),
        runs: [] as Record<string, any>[],
    };
});

vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

vi.mock("../lib/job-queue", () => {
    return {
        enqueueJob: async (_ref: unknown, args: Record<string, any>, options: Record<string, any>) => {
            if (probe.enqueueFails) {
                throw new Error("queue unavailable");
            }

            // What a consumer that starts the moment the message is sent would read: the claim must already be committed.
            probe.leaseSeenAtEnqueue = await probe.readLease?.(args.linkId);
            enqueued.push({ args, options });
        },
    };
});

vi.mock("../tasks/account", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../tasks/account")>()),
        chargeRound: async () => {
            probe.charges += 1;

            return probe.allowRound;
        },
        loadTaskAccount: async () => {
            return { isAdmin: false, isAnonymous: probe.anonymous, tier: probe.tier };
        },
        refundRoundKeys: async (_ctx: unknown, _userId: string, keys: string[]) => {
            probe.refunds += 1;
            probe.refundedKeys.push(keys);
        },
    };
});

vi.mock("../chat/lib/headless-run", () => {
    return {
        runHeadlessAgent: async (_ctx: unknown, options: Record<string, any>) => {
            runs.push(options);

            if (probe.failBeforeModel) {
                // The plan changes between the charge and the refund.
                probe.tier = "free";

                throw probe.failWith ?? new Error("failed before the model");
            }

            await options.onGenerationStart?.();
            await probe.during?.();

            if (probe.fail) {
                throw probe.failWith ?? new Error("run failed");
            }

            return { text: "ok", threadId: options.thread.threadId };
        },
    };
});

const {
    applyWatchWakeRefund,
    beginWatchWake,
    completeWatchWake,
    finishWatchWake,
    isTerminalWakeError,
    PR_WATCH_MAX_WAKE_FAILURES,
    PR_WATCH_WAKE_LEASE_MS,
    releaseWatchWake,
    runWatchWake,
    startWatchWake,
    wakePrompt,
} = await import("./pr-watch-wake");

const { recordWatchObservation } = await import("./pr-watch-poll");
const { JOB_LEASE_MS } = await import("../lib/job-once");

/** Stands in for the run's own `AgentRunError` (matched by name, so the suite need not load the agent run). */
class AgentRunErrorStandIn extends Error {
    public override name = "AgentRunError";
}

const OWNER = "user-a";
const STARTED_AT = 1000;
const LEASE = 5000;

let harness: ReturnType<typeof lunoraTest>;

beforeAll(async () => {
    registerModule(registry, "source_control_pr_watch_wake", await import("./pr-watch-wake"));
});

beforeEach(() => {
    runs.length = 0;
    enqueued.length = 0;
    probe.allowRound = true;
    probe.anonymous = false;
    probe.charges = 0;
    probe.enqueueFails = false;
    probe.failBeforeModel = false;
    probe.leaseSeenAtEnqueue = undefined;
    probe.readLease = undefined;
    probe.refunds = 0;
    probe.refundedKeys = [];
    probe.during = undefined;
    probe.tier = "premium";
    probe.fail = false;
    probe.failWith = undefined;
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const seed = async (extra: Record<string, unknown> = {}, thread: Record<string, unknown> = {}): Promise<{ linkId: string; threadId: string }> =>
    await harness.run(async (ctx: any) => {
        const threadId = await insertThread(ctx.db, {
            createdBy: OWNER,
            mode: "text",
            model: "gpt-4o",
            status: "active",
            tags: ["chat"],
            title: "work",
            updatedAt: Date.now(),
            userId: OWNER,
            ...thread,
        });
        const linkId = await ctx.db.insert("pullRequestThreads", {
            createdAt: 0,
            kind: "linked",
            number: 7,
            repository: "octo/hello",
            threadId,
            title: "pull",
            url: "https://github.com/octo/hello/pull/7",
            userId: OWNER,
            watch: { baselined: true, checksHeadSha: "sha-1", headSha: "sha-1", startedAt: STARTED_AT },
            watchActive: true,
            watchCheckedAt: LEASE,
            watchPending: ["checks"],
            watchRun: "run-1",
            ...extra,
        });

        return { linkId: String(linkId), threadId: String(threadId) };
    });

const rowOf = async (linkId: string): Promise<any> => await harness.run(async (ctx: any) => await ctx.db.get("pullRequestThreads", linkId));
const key = (linkId: string) => {
    return { linkId, run: "run-1", startedAt: STARTED_AT };
};
const start = async (linkId: string, args: Record<string, unknown> = {}): Promise<boolean> => {
    probe.readLease = async (id) => {
        const row = await rowOf(String(id));

        return row?.watchWakeLeaseUntil;
    };

    return await harness.action(async (ctx: any) => await ctx.runAction(startWatchWake, { ...key(linkId), ...args }));
};
/**
 * The job as the claim-once wrapper (`lib/job-once.ts:runJobOnce`) invokes it: the enqueued args plus the claim key as `jobId`
 * (`ctx.runAction(reference, { ...args, jobId })`). The harness cannot dispatch the wrapper's by-name reference, so the call is made
 * here with that exact argument shape: an action that does not declare `jobId` rejects it, as it did in production.
 */
const runJob = async (job: { args: Record<string, any>; options: Record<string, any> }): Promise<void> => {
    await harness.action(async (ctx: any) => await ctx.runAction(runWatchWake, { ...job.args, jobId: job.options.once.jobId }));
};

describe("the scheduled step", () => {
    it("claims, commits the lease, then enqueues the turn on the jobs queue: it runs no model and charges nothing yet", async () => {
        const { linkId, threadId } = await seed();

        expect(await start(linkId)).toBe(true);

        const row = await rowOf(linkId);

        expect(runs).toHaveLength(0);
        expect(probe.charges).toBe(0);
        expect(enqueued).toHaveLength(1);
        // A consumer starting the moment the message is sent already finds the committed lease.
        expect(probe.leaseSeenAtEnqueue).toBe(enqueued[0]?.args.claim);
        expect(enqueued[0]?.args).toMatchObject({ linkId, model: "gpt-4o", reasons: ["checks"], threadId, userId: OWNER });
        expect(enqueued[0]?.options).toMatchObject({ once: { userId: OWNER }, shardKey: OWNER });
        expect(row.watchWakeLeaseUntil).toBe(enqueued[0]?.args.claim);
        // Nothing is counted or cleared until the turn ran.
        expect(row.watchPending).toEqual(["checks"]);
        expect(row.watch.wakes).toBeUndefined();
    });

    it("releases the claim at once, counting nothing, when the queue send fails", async () => {
        const { linkId } = await seed();

        probe.enqueueFails = true;

        expect(await start(linkId)).toBe(false);

        const row = await rowOf(linkId);

        expect(row.watchWakeLeaseUntil).toBe(0);
        expect(row.watchPending).toEqual(["checks"]);
        expect(row.watch.wakes).toBeUndefined();
        expect(row.watchWakeFailure).toBeUndefined();

        // The next poll claims again.
        probe.enqueueFails = false;
        expect(await start(linkId)).toBe(true);
    });

    it("refuses an account that may not run unattended turns", async () => {
        const { linkId } = await seed();

        probe.anonymous = true;

        expect(await start(linkId)).toBe(false);
        expect(enqueued).toHaveLength(0);
    });

    it("refuses at the cap of wakes, inside the cooldown, with nothing pending, and for another run or start", async () => {
        const capped = await seed({ watch: { baselined: true, startedAt: STARTED_AT, wakes: PR_WATCH_MAX_WAKES } });
        const cooling = await seed({ watch: { baselined: true, lastWakeAt: Date.now() - PR_WATCH_WAKE_COOLDOWN_MS / 2, startedAt: STARTED_AT, wakes: 1 } });
        const empty = await seed({ watchPending: [] });
        const live = await seed();

        expect(await start(capped.linkId)).toBe(false);
        expect(await start(cooling.linkId)).toBe(false);
        expect(await start(empty.linkId)).toBe(false);
        expect(await start(live.linkId, { run: "run-2" })).toBe(false);
        expect(await start(live.linkId, { startedAt: STARTED_AT + 1 })).toBe(false);
        expect(await start(live.linkId)).toBe(true);
    });

    it("refuses a stopped watch, a locked thread and a thread that is streaming a reply", async () => {
        const stopped = await seed({ watch: { baselined: true, startedAt: STARTED_AT, stoppedAt: 2000 }, watchActive: false });
        const locked = await seed({}, { lockedAt: Date.now() });
        const busy = await seed();

        await harness.run(async (ctx: any) => {
            await ctx.db.persistentStreams.insert({ status: "streaming", threadId: busy.threadId });
        });

        expect(await start(stopped.linkId)).toBe(false);
        expect(await start(locked.linkId)).toBe(false);
        expect(await start(busy.linkId)).toBe(false);
    });

    it("refuses a claim in a thread another watch's turn is running in", async () => {
        const first = await seed();
        const second = await harness.run(async (ctx: any) => {
            const link = await ctx.db.get("pullRequestThreads", first.linkId);

            return String(
                await ctx.db.insert("pullRequestThreads", {
                    createdAt: 0,
                    kind: "linked",
                    number: 8,
                    repository: "octo/hello",
                    threadId: link.threadId,
                    title: "pull 8",
                    url: "https://github.com/octo/hello/pull/8",
                    userId: OWNER,
                    watch: { baselined: true, checksHeadSha: "sha-1", headSha: "sha-1", startedAt: STARTED_AT },
                    watchActive: true,
                    watchPending: ["checks"],
                    watchRun: "run-1",
                }),
            );
        });

        expect(await start(first.linkId)).toBe(true);
        // The same thread, a different pull request: it waits for the first turn.
        expect(await start(second)).toBe(false);
        expect(enqueued).toHaveLength(1);

        // Once the first turn has ended, the second goes ahead.
        await runJob(enqueued[0]!);
        expect(await start(second)).toBe(true);
    });

    it("hands the lease to one claimant only, also past the old 14-minute mark", async () => {
        const { linkId } = await seed();

        expect(await start(linkId)).toBe(true);
        expect(await start(linkId)).toBe(false);

        // 14 minutes later the first turn can still be running: the lease outlasts the longest a queue job may run.
        expect(PR_WATCH_WAKE_LEASE_MS).toBeGreaterThan(JOB_LEASE_MS);
        expect(PR_WATCH_WAKE_LEASE_MS).toBeGreaterThan(14 * 60 * 1000);

        vi.useFakeTimers({ now: Date.now() + 14 * 60 * 1000 + 1000, toFake: ["Date"] });

        try {
            expect(await start(linkId)).toBe(false);
        } finally {
            vi.useRealTimers();
        }

        expect(enqueued).toHaveLength(1);
    });
});

describe("the job's argument shape", () => {
    it("declares the jobId the claim-once wrapper adds, and every argument the scheduled step enqueues", async () => {
        const { linkId } = await seed();

        await start(linkId);

        // The wrapper calls the target with `{ ...args, jobId }` and the host refuses an argument the action does not declare.
        const declared = Object.keys((runWatchWake as unknown as { args: Record<string, unknown> }).args);

        expect(declared).toContain("jobId");

        const enqueuedNames = Object.keys(enqueued[0]!.args);

        for (const name of enqueuedNames) {
            expect(declared).toContain(name);
        }
    });
});

describe("the job", () => {
    it("runs one turn in the linked thread, then counts the wake once and clears what it delivered", async () => {
        const { linkId, threadId } = await seed();

        await start(linkId);
        await runJob(enqueued[0]!);

        const row = await rowOf(linkId);

        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ model: "gpt-4o", organizationId: null, origin: "trigger", thread: { threadId }, tools: "headless", userId: OWNER });
        expect(runs[0]?.prompt).toBe(wakePrompt({ number: 7, repository: "octo/hello" }, ["checks"]));
        expect(row.watchPending).toEqual([]);
        expect(row.watch).toMatchObject({ wakes: 1 });
        expect(row.watch.lastWakeAt).toBeGreaterThan(0);
        expect(row.watchWakeLeaseUntil).toBe(0);
    });

    it("keeps the reasons pending and the count where it was when the turn fails, and releases the lease", async () => {
        const { linkId } = await seed({ watch: { baselined: true, checksHeadSha: "sha-1", startedAt: STARTED_AT, wakes: 2 } });

        await start(linkId);
        probe.fail = true;
        await runJob(enqueued[0]!);

        const row = await rowOf(linkId);

        expect(runs).toHaveLength(1);
        expect(row.watchPending).toEqual(["checks"]);
        expect(row.watch.wakes).toBe(2);
        expect(row.watch.lastWakeAt).toBeUndefined();
        expect(row.watchWakeLeaseUntil).toBe(0);
    });

    it("runs no turn for a watch stopped since the claim, and releases the lease", async () => {
        const { linkId } = await seed();

        await start(linkId);
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("pullRequestThreads", linkId, { watch: { baselined: true, startedAt: STARTED_AT, stoppedAt: 2000 }, watchActive: false });
        });
        await runJob(enqueued[0]!);

        expect(runs).toHaveLength(0);
        const stopped = await rowOf(linkId);

        expect(stopped.watchWakeLeaseUntil).toBe(0);
    });

    it("leaves a checks occurrence recorded while the turn ran pending, and counts the delivered one", async () => {
        const { linkId } = await seed();

        await start(linkId);

        // While the turn runs, the poller records a second failing head (a new occurrence of the same kind).
        await harness.run(async (ctx: any) => {
            const row = await ctx.db.get("pullRequestThreads", linkId);

            await ctx.db.patch("pullRequestThreads", linkId, { watch: { ...row.watch, checksHeadSha: "sha-2", headSha: "sha-2" } });
        });
        await runJob(enqueued[0]!);

        const row = await rowOf(linkId);

        expect(row.watchPending).toEqual(["checks"]);
        expect(row.watch.wakes).toBe(1);
        expect(row.watchWakeLeaseUntil).toBe(0);
    });

    it("clears only the delivered kinds: a review recorded meanwhile stays", async () => {
        const { linkId } = await seed();

        await start(linkId);
        await harness.run(async (ctx: any) => {
            const row = await ctx.db.get("pullRequestThreads", linkId);

            await ctx.db.patch("pullRequestThreads", linkId, { watch: { ...row.watch, reviewId: "9" }, watchPending: ["checks", "review"] });
        });
        await runJob(enqueued[0]!);

        const after = await rowOf(linkId);

        expect(after.watchPending).toEqual(["review"]);
    });
});

describe("a failing wake turn", () => {
    const failOnce = async (linkId: string): Promise<void> => {
        await start(linkId);
        probe.fail = true;
        await runJob(enqueued.at(-1)!);
        probe.fail = false;
    };

    it("records the failure, keeps the reasons and waits the retry time before another delivery", async () => {
        const { linkId } = await seed();

        await failOnce(linkId);

        const row = await rowOf(linkId);

        expect(row.watchWakeFailure).toMatchObject({ attempts: 1, kind: "retryable" });
        expect(row.watchWakeFailure.retryAt).toBeGreaterThan(Date.now());
        expect(row.watchPending).toEqual(["checks"]);
        expect(row.watch.wakes).toBeUndefined();
        expect(row.watchActive).toBe(true);

        // The next poll finds the reasons pending but the retry time not reached: nothing is claimed or charged.
        const { charges } = probe;

        expect(await start(linkId)).toBe(false);
        expect(probe.charges).toBe(charges);

        // Past the retry time it goes ahead.
        vi.useFakeTimers({ now: row.watchWakeFailure.retryAt + 1000, toFake: ["Date"] });

        try {
            expect(await start(linkId)).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("stops the watch at the third failure in a row, keeping the last failure", async () => {
        const { linkId } = await seed({ watchWakeFailure: { at: 1, attempts: PR_WATCH_MAX_WAKE_FAILURES - 1, kind: "retryable", retryAt: 0 } });

        await failOnce(linkId);

        const row = await rowOf(linkId);

        expect(row.watchActive).toBe(false);
        expect(row.watch.stoppedAt).toBeGreaterThan(0);
        expect(row.watchWakeFailure).toMatchObject({ attempts: PR_WATCH_MAX_WAKE_FAILURES, kind: "retryable" });
        expect(row.watchPending).toEqual(["checks"]);
    });

    it("stops the watch at once for an error that trying again cannot cure", async () => {
        const { linkId } = await seed();

        probe.failWith = new AgentRunErrorStandIn("left");
        await failOnce(linkId);

        const row = await rowOf(linkId);

        expect(row.watchActive).toBe(false);
        expect(row.watchWakeFailure).toMatchObject({ attempts: 1, kind: "terminal" });
    });

    it("classifies terminal and retryable errors", async () => {
        const { LunoraError } = await import("lunorash/server");

        expect(isTerminalWakeError(new AgentRunErrorStandIn("x"))).toBe(true);
        expect(isTerminalWakeError(new LunoraError("FORBIDDEN", "no"))).toBe(true);
        expect(isTerminalWakeError(new LunoraError("NOT_FOUND", "gone"))).toBe(true);
        expect(isTerminalWakeError(new Error("503 from the provider"))).toBe(false);
        expect(isTerminalWakeError(new LunoraError("INTERNAL_SERVER_ERROR", "boom"))).toBe(false);
    });

    it("resets the count on a delivery, keeping the last failure as history", async () => {
        const { linkId } = await seed({ watchWakeFailure: { at: 5, attempts: 2, kind: "retryable", retryAt: 0 } });

        await start(linkId);
        await runJob(enqueued.at(-1)!);

        const row = await rowOf(linkId);

        expect(row.watchWakeFailure).toMatchObject({ at: 5, attempts: 0, retryAt: 0 });
        expect(row.watch.wakes).toBe(1);
    });
});

describe("the check right before the turn", () => {
    const claimed = async (extra: Record<string, unknown> = {}, thread: Record<string, unknown> = {}) => {
        const made = await seed(extra, thread);

        await start(made.linkId);

        return { ...made, job: enqueued.at(-1)! };
    };

    it("runs no turn for a reply that started since the claim, frees the lease and counts no failure", async () => {
        const { job, linkId, threadId } = await claimed();

        await harness.run(async (ctx: any) => {
            await ctx.db.persistentStreams.insert({ status: "streaming", threadId });
        });
        await runJob(job);

        const row = await rowOf(linkId);

        expect(runs).toHaveLength(0);
        expect(row.watchWakeLeaseUntil).toBe(0);
        expect(row.watchPending).toEqual(["checks"]);
        expect(row.watch.wakes).toBeUndefined();
        expect(row.watchWakeFailure).toMatchObject({ attempts: 0, kind: "retryable" });
        expect(row.watchWakeFailure.retryAt).toBeGreaterThan(Date.now());
        expect(row.watchActive).toBe(true);
    });

    it.each([
        ["locked", { lockedAt: Date.now() }],
        ["deleted", { deleted: true }],
        ["being deleted", { deletingAt: Date.now() }],
    ])("runs no turn for a thread that is %s since the claim, and counts nothing", async (_name, patch) => {
        const { job, linkId, threadId } = await claimed();

        await harness.run(async (ctx: any) => {
            await ctx.db.patch("threads", threadId, patch);
        });
        await runJob(job);

        const row = await rowOf(linkId);

        expect(runs).toHaveLength(0);
        expect(row.watchWakeLeaseUntil).toBe(0);
        expect(row.watchPending).toEqual(["checks"]);
        expect(row.watch.wakes).toBeUndefined();
        expect(row.watchWakeFailure.attempts).toBe(0);
    });

    it("runs no turn when its lease is no longer the current one, and leaves the newer claim alone", async () => {
        const { job, linkId } = await claimed();

        // A newer claim replaced this one while the job waited in the queue.
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("pullRequestThreads", linkId, { watchWakeLeaseUntil: job.args.claim + 12_345 });
        });
        await runJob(job);

        const row = await rowOf(linkId);

        expect(runs).toHaveLength(0);
        expect(row.watchWakeLeaseUntil).toBe(job.args.claim + 12_345);
        expect(row.watchPending).toEqual(["checks"]);
        expect(row.watch.wakes).toBeUndefined();
    });

    it("charges one round only when the turn starts", async () => {
        const { job } = await claimed();

        expect(probe.charges).toBe(0);

        await runJob(job);

        expect(probe.charges).toBe(1);
        expect(runs).toHaveLength(1);
    });

    it("charges nothing for a job whose watch was stopped since the claim", async () => {
        const { job, linkId } = await claimed();

        await harness.run(async (ctx: any) => {
            await ctx.db.patch("pullRequestThreads", linkId, { watch: { baselined: true, startedAt: STARTED_AT, stoppedAt: 2000 }, watchActive: false });
        });
        await runJob(job);

        expect(probe.charges).toBe(0);
        expect(runs).toHaveLength(0);
    });

    it("runs no turn, counts nothing and waits the retry spacing when a daily limit is spent", async () => {
        const { job, linkId } = await claimed();

        probe.allowRound = false;
        await runJob(job);

        const row = await rowOf(linkId);

        expect(runs).toHaveLength(0);
        expect(row.watchWakeLeaseUntil).toBe(0);
        expect(row.watchPending).toEqual(["checks"]);
        expect(row.watch.wakes).toBeUndefined();
        expect(row.watchWakeFailure).toMatchObject({ attempts: 0, kind: "retryable" });
        expect(row.watchWakeFailure.retryAt).toBeGreaterThan(Date.now());

        // The next claim waits; once the retry time has passed and the limit has room, it goes ahead.
        expect(await start(linkId)).toBe(false);
        probe.allowRound = true;
        vi.useFakeTimers({ now: row.watchWakeFailure.retryAt + 1000, toFake: ["Date"] });

        try {
            expect(await start(linkId)).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("gives the round back for a turn that fails before it reaches the model, and not for one that did", async () => {
        const first = await claimed();

        probe.failBeforeModel = true;
        await runJob(first.job);
        expect(probe.charges).toBe(1);
        expect(probe.refunds).toBe(1);
        // The buckets the charge took (premium), not the ones the account maps to when the refund runs (free).
        expect(probe.refundedKeys[0]).toEqual(["chat/dailyText:premium", "tasks/dailyRuns:premium"]);
        expect(probe.tier).toBe("free");
        probe.tier = "premium";

        probe.failBeforeModel = false;
        enqueued.length = 0;

        const second = await claimed();

        probe.fail = true;
        await runJob(second.job);
        // The model was reached (and may have been billed): the round stays charged.
        expect(probe.charges).toBe(2);
        expect(probe.refunds).toBe(1);
    });

    it("runs no turn for a job delivered after its lease ended, and frees the lease", async () => {
        const { job, linkId } = await claimed();

        vi.useFakeTimers({ now: job.args.claim + 1000, toFake: ["Date"] });

        try {
            await runJob(job);
        } finally {
            vi.useRealTimers();
        }

        const row = await rowOf(linkId);

        expect(runs).toHaveLength(0);
        expect(probe.charges).toBe(0);
        expect(row.watchWakeLeaseUntil).toBe(0);
        expect(row.watchPending).toEqual(["checks"]);
        expect(row.watch.wakes).toBeUndefined();
    });

    it("answers `run` only while the delivery holds the lease on the same watch", async () => {
        const { job, linkId } = await claimed();
        const begin = async (claim: number) =>
            await harness.run(
                async (ctx: any) => await ctx.runMutation(beginWatchWake, { ...key(linkId), claim, markers: { checks: "sha-1" }, reasons: ["checks"] }),
            );

        expect(await begin(job.args.claim)).toMatchObject({ charged: expect.any(Array), status: "run" });
        expect(await begin(1)).toEqual({ status: "stale" });
    });
});

describe("a settlement that fails after the turn ran", () => {
    it("is tried again without asking the model a second time, and counts the wake once", async () => {
        const { linkId } = await seed();

        await start(linkId);

        // The first settlement fails, as a write that is lost would: only it is repeated, never the turn.
        let failures = 1;

        await harness.action(async (ctx: any) => {
            const real = ctx.runMutation.bind(ctx);

            ctx.runMutation = async (reference: unknown, args: unknown) => {
                if (reference === finishWatchWake && failures > 0) {
                    failures -= 1;

                    throw new Error("write failed");
                }

                return await real(reference, args);
            };

            await ctx.runAction(runWatchWake, { ...enqueued[0]!.args, jobId: enqueued[0]!.options.once.jobId });
        });

        const row = await rowOf(linkId);

        expect(runs).toHaveLength(1);
        expect(row.watch.wakes).toBe(1);
        expect(row.watchPending).toEqual([]);
    });
});

describe("a settlement that never lands", () => {
    /** Runs the job with every call of the named mutation failing. */
    const runWithBrokenWrite = async (job: { args: Record<string, any>; options: Record<string, any> }, broken: unknown, times = Infinity) => {
        let left = times;

        return await harness
            .action(async (ctx: any) => {
                const real = ctx.runMutation.bind(ctx);

                ctx.runMutation = async (reference: unknown, args: unknown) => {
                    if (reference === broken && left > 0) {
                        left -= 1;

                        throw new Error("write failed");
                    }

                    return await real(reference, args);
                };

                await ctx.runAction(runWatchWake, { ...job.args, jobId: job.options.once.jobId });
            })
            .then(() => "ok")
            .catch(() => "failed");
    };

    it("settles a completed turn on the next claim and never generates again for the same reasons", async () => {
        const { linkId } = await seed();

        await start(linkId);
        expect(await runWithBrokenWrite(enqueued[0]!, finishWatchWake)).toBe("failed");

        const stuck = await rowOf(linkId);

        expect(runs).toHaveLength(1);
        expect(stuck.watchWakeCompleted).toMatchObject({ done: false, reasons: ["checks"] });
        expect(stuck.watchPending).toEqual(["checks"]);
        expect(stuck.watch.wakes).toBeUndefined();

        // The lease lapses; the next poll's claim settles the completed turn instead of asking the model again.
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("pullRequestThreads", linkId, { watchWakeLeaseUntil: Date.now() - 1000 });
        });
        expect(await start(linkId)).toBe(false);

        const settled = await rowOf(linkId);

        expect(runs).toHaveLength(1);
        expect(enqueued).toHaveLength(1);
        expect(settled.watchWakeCompleted).toMatchObject({ done: true });
        expect(settled.watchPending).toEqual([]);
        expect(settled.watch.wakes).toBe(1);
    });
});

describe("a refund that fails", () => {
    it("is retried on its own and applied once", async () => {
        const { linkId } = await seed();

        await start(linkId);
        probe.failBeforeModel = true;
        await harness.action(async (ctx: any) => {
            const real = ctx.runMutation.bind(ctx);
            let failures = 1;

            ctx.runMutation = async (reference: unknown, args: unknown) => {
                if (reference === applyWatchWakeRefund && failures > 0) {
                    failures -= 1;

                    throw new Error("refund failed");
                }

                return await real(reference, args);
            };

            await ctx.runAction(runWatchWake, { ...enqueued[0]!.args, jobId: enqueued[0]!.options.once.jobId });
        });

        const row = await rowOf(linkId);

        expect(probe.refunds).toBe(1);
        expect(row.watchWakeRefund).toMatchObject({ applied: true });
    });

    it("stays owed until the next charge pays it, once, before charging again", async () => {
        const { linkId } = await seed();

        await start(linkId);
        probe.failBeforeModel = true;
        await harness.action(async (ctx: any) => {
            const real = ctx.runMutation.bind(ctx);

            ctx.runMutation = async (reference: unknown, args: unknown) => {
                if (reference === applyWatchWakeRefund) {
                    throw new Error("refund failed");
                }

                return await real(reference, args);
            };

            await ctx.runAction(runWatchWake, { ...enqueued[0]!.args, jobId: enqueued[0]!.options.once.jobId });
        });

        const owed = await rowOf(linkId);

        expect(probe.refunds).toBe(0);
        expect(owed.watchWakeRefund).toMatchObject({ applied: false, keys: ["chat/dailyText:premium", "tasks/dailyRuns:premium"] });

        // The retry time passes; the next attempt pays the owed refund first, then charges, so no second charge stacks unreconciled.
        probe.failBeforeModel = false;
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("pullRequestThreads", linkId, { watchWakeFailure: { at: 1, attempts: 1, kind: "retryable", retryAt: 0 } });
        });
        expect(await start(linkId)).toBe(true);
        await runJob(enqueued[1]!);

        const row = await rowOf(linkId);

        expect(probe.refunds).toBe(1);
        expect(probe.charges).toBe(2);
        expect(row.watchWakeRefund).toMatchObject({ applied: true });
    });
});

describe("a chat that stops being the owner's alone", () => {
    const setPublic = async (threadId: string, isPublic: boolean) => {
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("threads", threadId, { isPublic });
        });
    };

    it("is not woken once shared, keeps the reasons, burns no cooldown or cap, and is woken again when unshared", async () => {
        const { linkId, threadId } = await seed();

        // Shared after the watch started: the claim refuses, and notes the pause once.
        await setPublic(threadId, true);
        expect(await start(linkId)).toBe(false);

        const paused = await rowOf(linkId);

        expect(enqueued).toHaveLength(0);
        expect(runs).toHaveLength(0);
        expect(paused.watchWakeFailure).toMatchObject({ attempts: 0, kind: "shared", retryAt: 0 });
        expect(paused.watchPending).toEqual(["checks"]);
        expect(paused.watch.wakes).toBeUndefined();
        expect(paused.watch.lastWakeAt).toBeUndefined();
        expect(paused.watchActive).toBe(true);

        // Noted once: a later poll does not rewrite it.
        expect(await start(linkId)).toBe(false);

        const again = await rowOf(linkId);

        expect(again.watchWakeFailure.at).toBe(paused.watchWakeFailure.at);

        // Unshared: the next poll's delivery goes ahead and ends the pause.
        await setPublic(threadId, false);
        expect(await start(linkId)).toBe(true);
        await runJob(enqueued[0]!);

        const resumed = await rowOf(linkId);

        expect(runs).toHaveLength(1);
        expect(resumed.watch.wakes).toBe(1);
        expect(resumed.watchPending).toEqual([]);
        expect(resumed.watchWakeFailure).toMatchObject({ attempts: 0, kind: "retryable" });
    });

    it("runs no turn for a job whose chat was shared after the claim, releasing the lease and counting nothing", async () => {
        const { linkId, threadId } = await seed();

        await start(linkId);
        await setPublic(threadId, true);
        await runJob(enqueued[0]!);

        const row = await rowOf(linkId);

        expect(runs).toHaveLength(0);
        expect(probe.charges).toBe(0);
        expect(row.watchWakeLeaseUntil).toBe(0);
        expect(row.watchPending).toEqual(["checks"]);
        expect(row.watch.wakes).toBeUndefined();
        expect(row.watchWakeFailure).toMatchObject({ attempts: 0, kind: "shared", retryAt: 0 });
    });
});

describe("at most one model call per occurrence", () => {
    const expireLease = async (linkId: string) => {
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("pullRequestThreads", linkId, { watchWakeLeaseUntil: Date.now() - 1000 });
        });
    };

    it("does not generate again when the completion write fails every time, and tells the owner on watchWakeFailure", async () => {
        const { linkId } = await seed();

        await start(linkId);
        await harness
            .action(async (ctx: any) => {
                const real = ctx.runMutation.bind(ctx);

                // The completion write and the settlement both keep failing after the turn ran.
                ctx.runMutation = async (reference: unknown, args: unknown) => {
                    if (reference === completeWatchWake || reference === finishWatchWake) {
                        throw new Error("write failed");
                    }

                    return await real(reference, args);
                };

                await ctx.runAction(runWatchWake, { ...enqueued[0]!.args, jobId: enqueued[0]!.options.once.jobId });
            })
            .catch(() => undefined);

        const stuck = await rowOf(linkId);

        expect(runs).toHaveLength(1);
        expect(stuck.watchWakeCompleted).toMatchObject({ done: false, state: "running" });

        // The lease lapses; the next poll does not run the model for the same reasons: the occurrence is settled as a failed attempt.
        await expireLease(linkId);
        expect(await start(linkId)).toBe(false);

        const settled = await rowOf(linkId);

        expect(runs).toHaveLength(1);
        expect(enqueued).toHaveLength(1);
        expect(settled.watchWakeCompleted).toMatchObject({ done: true });
        expect(settled.watchWakeFailure).toMatchObject({ attempts: 1, kind: "retryable" });
        expect(settled.watchPending).toEqual(["checks"]);
        expect(settled.watch.wakes).toBeUndefined();
    });

    it("refunds once for a job that died after the charge and before the model, and charges once on the next attempt", async () => {
        const { linkId } = await seed();

        await start(linkId);

        const job = enqueued[0]!;

        // The job's first step runs (the charge and the occurrence are committed), then it dies before the model.
        const begun = await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(beginWatchWake, { ...key(linkId), claim: job.args.claim, markers: job.args.markers, reasons: job.args.reasons }),
        );

        expect(begun).toMatchObject({ status: "run" });
        expect(probe.charges).toBe(1);

        const owed = await rowOf(linkId);

        expect(owed.watchWakeRefund).toMatchObject({ applied: false, keys: ["chat/dailyText:premium", "tasks/dailyRuns:premium"] });
        expect(owed.watchWakeRefund.windowEnds).toHaveLength(2);

        // The claim's lapse handler reconciles it: refunded once, lease released.
        const lapse = async () =>
            await harness.run(async (ctx: any) => await ctx.runMutation(releaseWatchWake, { ...key(linkId), claim: job.args.claim, claimKey: "job-1" }));

        await lapse();
        await lapse();
        expect(probe.refunds).toBe(1);
        const released = await rowOf(linkId);

        expect(released.watchWakeLeaseUntil).toBe(0);

        // The next claim settles the started occurrence as a failed attempt (no second refund), waits its retry time, then charges once.
        expect(await start(linkId)).toBe(false);
        expect(probe.refunds).toBe(1);

        const failed = await rowOf(linkId);

        vi.useFakeTimers({ now: failed.watchWakeFailure.retryAt + 1000, toFake: ["Date"] });

        try {
            expect(await start(linkId)).toBe(true);
            await runJob(enqueued[1]!);
        } finally {
            vi.useRealTimers();
        }

        expect(probe.charges).toBe(2);
        expect(probe.refunds).toBe(1);
        expect(runs).toHaveLength(1);
    });
});

describe("a watch stopped or restarted during its turn", () => {
    it("counts the delivered turn once against the run it started under when the watch is stopped meanwhile", async () => {
        const { linkId, threadId } = await seed();

        await start(linkId);
        probe.during = async () => {
            await harness.run(
                async (ctx: any) =>
                    await ctx.runMutation(setPullRequestWatch, { number: 7, repository: "octo/hello", threadId, userId: OWNER, watching: false }),
            );
        };
        await runJob(enqueued[0]!);

        const row = await rowOf(linkId);

        expect(runs).toHaveLength(1);
        expect(row.watchActive).toBe(false);
        expect(row.watch.wakes).toBe(1);
        expect(row.watch.stoppedAt).toBeGreaterThan(0);
        expect(row.watchWakeLeaseUntil).toBe(0);
    });

    it("does not count it against a restarted run, which starts with the count it carried", async () => {
        const { linkId, threadId } = await seed();

        await start(linkId);
        probe.during = async () => {
            await harness.run(async (ctx: any) => {
                for (const watching of [false, true]) {
                    await ctx.runMutation(setPullRequestWatch, { number: 7, repository: "octo/hello", threadId, userId: OWNER, watching });
                }
            });
        };
        await runJob(enqueued[0]!);

        const row = await rowOf(linkId);

        expect(row.watchActive).toBe(true);
        expect(row.watch.wakes).toBeUndefined();
        expect(row.watch.lastWakeAt).toBeUndefined();
        expect(row.watchWakeLeaseUntil).toBe(0);
    });
});

describe("an occurrence left by another run", () => {
    it("is discarded when the watch restarts, and the new run's first wake is delivered", async () => {
        const stale = { claim: 1, done: false, markers: { checks: "sha-1" }, reasons: ["checks"], run: "run-1", startedAt: STARTED_AT, state: "completed" };
        const { linkId, threadId } = await seed({ watchWakeCompleted: stale });

        // Stopped, then restarted: a new run starts, with the old occurrence discarded and the count untouched.
        await harness.run(async (ctx: any) => {
            for (const watching of [false, true]) {
                await ctx.runMutation(setPullRequestWatch, { number: 7, repository: "octo/hello", threadId, userId: OWNER, watching });
            }
        });

        const restarted = await rowOf(linkId);

        expect(restarted.watchWakeCompleted).toMatchObject({ done: true });
        expect(restarted.watch.wakes).toBeUndefined();

        await harness.run(async (ctx: any) => {
            await ctx.db.patch("pullRequestThreads", linkId, { watchPending: ["checks"] });
        });
        expect(
            await harness.action(
                async (ctx: any) => await ctx.runAction(startWatchWake, { linkId, run: restarted.watchRun, startedAt: restarted.watch.startedAt }),
            ),
        ).toBe(true);
        await harness.action(async (ctx: any) => await ctx.runAction(runWatchWake, { ...enqueued[0]!.args, jobId: enqueued[0]!.options.once.jobId }));

        const row = await rowOf(linkId);

        expect(runs).toHaveLength(1);
        expect(row.watch.wakes).toBe(1);
    });

    it("is discarded by a claim that finds it belonging to another run, leaving the count and the pending reasons alone", async () => {
        const stale = {
            claim: 1,
            done: false,
            markers: { checks: "sha-1" },
            reasons: ["checks"],
            run: "old-run",
            startedAt: STARTED_AT - 1,
            state: "completed",
        };
        const { linkId } = await seed({ watchWakeCompleted: stale });

        expect(await start(linkId)).toBe(true);

        const row = await rowOf(linkId);

        // Not settled against this run: nothing was counted, and the claim went on to deliver this run's own reasons.
        expect(row.watch.wakes).toBeUndefined();
        expect(row.watchPending).toEqual(["checks"]);
        expect(row.watchWakeCompleted).toMatchObject({ done: true });
        expect(enqueued).toHaveLength(1);
    });
});

describe("a restarted watch", () => {
    it("starts a new failure streak and is not held back by the old retry time", async () => {
        const { linkId, threadId } = await seed();
        const failOnce = async () => {
            const row = await rowOf(linkId);

            await harness.run(async (ctx: any) => {
                await ctx.db.patch("pullRequestThreads", linkId, {
                    watchPending: ["checks"],
                    ...(row.watchWakeFailure !== undefined && { watchWakeFailure: { ...row.watchWakeFailure, retryAt: 0 } }),
                });
            });
            await harness.action(async (ctx: any) => await ctx.runAction(startWatchWake, { linkId, run: row.watchRun, startedAt: row.watch.startedAt }));
            probe.fail = true;
            await harness.action(
                async (ctx: any) => await ctx.runAction(runWatchWake, { ...enqueued.at(-1)!.args, jobId: enqueued.at(-1)!.options.once.jobId }),
            );
            probe.fail = false;
        };

        for (let index = 0; index < PR_WATCH_MAX_WAKE_FAILURES; index += 1) {
            await failOnce();
        }

        const stopped = await rowOf(linkId);

        expect(stopped.watchActive).toBe(false);
        expect(stopped.watchWakeFailure).toMatchObject({ attempts: PR_WATCH_MAX_WAKE_FAILURES });

        await harness.run(
            async (ctx: any) => await ctx.runMutation(setPullRequestWatch, { number: 7, repository: "octo/hello", threadId, userId: OWNER, watching: true }),
        );

        const restarted = await rowOf(linkId);

        expect(restarted.watchActive).toBe(true);
        expect(restarted.watchWakeFailure).toMatchObject({ attempts: 0, retryAt: 0 });

        // The first claim of the new watch is not delayed by the old retry time, and it takes three new failures to stop it again.
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("pullRequestThreads", linkId, { watchPending: ["checks"] });
        });

        for (let index = 0; index < PR_WATCH_MAX_WAKE_FAILURES - 1; index += 1) {
            await failOnce();
            const still = await rowOf(linkId);

            expect(still.watchActive).toBe(true);
        }

        await failOnce();

        const ended = await rowOf(linkId);

        expect(ended.watchActive).toBe(false);
    });
});

describe("finishing and releasing", () => {
    const finish = async (linkId: string, claim: number, args: Record<string, unknown> = {}) =>
        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(finishWatchWake, { ...key(linkId), claim, delivered: true, markers: { checks: "sha-1" }, reasons: ["checks"], ...args }),
        );

    it("ignores a claim that is no longer the lease", async () => {
        const { linkId } = await seed({ watchPending: ["checks", "review"], watchWakeLeaseUntil: 9000 });

        await finish(linkId, 1);

        const untouched = await rowOf(linkId);

        expect(untouched.watch.wakes).toBeUndefined();

        await finish(linkId, 9000);

        const row = await rowOf(linkId);

        expect(row.watchPending).toEqual(["review"]);
        expect(row.watch.wakes).toBe(1);
    });

    it("frees the lease of a job that died, and only for its own claim", async () => {
        const { linkId } = await seed({ watchWakeLeaseUntil: 9000 });
        const release = async (claim: number) =>
            await harness.run(async (ctx: any) => await ctx.runMutation(releaseWatchWake, { ...key(linkId), claim, claimKey: "job-1" }));

        await release(1);

        const held = await rowOf(linkId);

        expect(held.watchWakeLeaseUntil).toBe(9000);

        await release(9000);

        const row = await rowOf(linkId);

        expect(row.watchWakeLeaseUntil).toBe(0);
        expect(row.watchPending).toEqual(["checks"]);
        expect(row.watch.wakes).toBeUndefined();
    });
});

describe("the poller's record of a wake", () => {
    it("schedules the claiming step once, and sends nothing itself", async () => {
        const { linkId } = await seed({ watch: { baselined: true, headSha: "sha-1", startedAt: STARTED_AT }, watchPending: [] });
        const before = harness.scheduler.list().length;

        await harness.run(async (ctx: any) => {
            await ctx.runMutation(recordWatchObservation, {
                lease: LEASE,
                linkId,
                observation: {
                    checks: "failing",
                    failingCheckNames: ["build"],
                    headSha: "sha-1",
                    mergeable: "clean",
                    reviews: [],
                    state: "open",
                    watcherLogin: "me",
                },
                run: "run-1",
                startedAt: STARTED_AT,
            });
        });

        const jobs = (harness.scheduler.list() as unknown as { args: Record<string, unknown> }[]).slice(before);

        // The claiming step is the one job that carries the watch's start and run.
        expect(jobs.filter((job) => job.args.startedAt === STARTED_AT && job.args.run === "run-1")).toHaveLength(1);
        expect(runs).toHaveLength(0);
        expect(enqueued).toHaveLength(0);

        const row = await rowOf(linkId);

        expect(row.watchPending).toEqual(["checks"]);
    });
});
