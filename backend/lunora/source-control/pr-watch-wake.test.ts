/* eslint-disable max-classes-per-file -- stand-ins for the run's own error classes */
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
            beforeStart: undefined as (() => Promise<void>) | undefined,
            charges: 0,
            during: undefined as (() => Promise<void>) | undefined,
            endsAfter: [9000, 9000] as number[],
            endsBefore: [9000, 9000] as number[],
            enqueueFails: false,
            fail: false,
            failBeforeModel: false,
            failWith: undefined as unknown,
            generated: 0,
            leaseSeenAtEnqueue: undefined as number | undefined,
            readLease: undefined as ((linkId: string) => Promise<number | undefined>) | undefined,
            refundedKeys: [] as string[][],
            refunds: 0,
            tier: "premium" as "free" | "premium",
            windowReads: 0,
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
        roundWindowEnds: async () => {
            probe.windowReads += 1;

            return probe.windowReads % 2 === 1 ? probe.endsBefore : probe.endsAfter;
        },
    };
});

vi.mock("../chat/lib/headless-run", () => {
    class FencedRunError extends Error {}

    return {
        FencedRunError,
        runHeadlessAgent: async (_ctx: unknown, options: Record<string, any>) => {
            runs.push(options);

            if (probe.failBeforeModel) {
                // The plan changes between the charge and the refund.
                probe.tier = "free";

                throw probe.failWith ?? new Error("failed before the model");
            }

            await probe.beforeStart?.();
            await options.onGenerationStart?.();
            probe.generated += 1;
            await probe.during?.();

            // As the run does: asked after the step, and a failing fence ends the run there.
            if (options.fence && !(await options.fence())) {
                return { text: "", threadId: options.thread.threadId };
            }

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
    keepWatchWakeCharge,
    PR_WATCH_MAX_WAKE_FAILURES,
    PR_WATCH_WAKE_LEASE_MS,
    releaseWatchWake,
    runWatchWake,
    startWatchWake,
    WAKE_TOOL_ALLOWLIST,
    wakePrompt,
} = await import("./pr-watch-wake");

const { recordWatchObservation } = await import("./pr-watch-poll");
const { JOB_LEASE_MS } = await import("../lib/job-once");

/** Stands in for the run's own `AgentRunError` (matched by name, so the suite need not load the agent run). */
class AgentRunErrorStandIn extends Error {
    public override name = "AgentRunError";
}

const OWNER = "user-a";
const { DEFAULT_CHAT_MODEL: MODEL } = await import("@neore/ai/constants");
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
    probe.beforeStart = undefined;
    probe.generated = 0;
    probe.windowReads = 0;
    probe.endsBefore = [Date.now() + 3_600_000, Date.now() + 3_600_000];
    probe.endsAfter = probe.endsBefore;
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
            model: MODEL,
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
        expect(enqueued[0]?.args).toMatchObject({ linkId, model: MODEL, reasons: ["checks"], threadId, userId: OWNER });
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
        expect(runs[0]).toMatchObject({ model: MODEL, organizationId: null, origin: "trigger", thread: { threadId }, tools: "headless", userId: OWNER });
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
        // Failed before the model was reached (refunded): such a turn is retryable, so a streak of them can build.
        probe.failBeforeModel = true;
        await runJob(enqueued.at(-1)!);
        probe.failBeforeModel = false;
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

    it("is paid by the failure's settlement when the job's own payment never lands, once", async () => {
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

        const row = await rowOf(linkId);

        expect(probe.refunds).toBe(1);
        expect(row.watchWakeRefund).toMatchObject({ applied: true });

        // Nothing is owed any more: the next charge pays nothing again.
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("pullRequestThreads", linkId, { watchWakeFailure: { at: 1, attempts: 1, kind: "retryable", retryAt: 0 } });
        });
        probe.failBeforeModel = false;
        expect(await start(linkId)).toBe(true);
        await runJob(enqueued[1]!);
        expect(probe.refunds).toBe(1);
        expect(probe.charges).toBe(2);
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

describe("the last check, right before the model is asked", () => {
    it("asks no model and gives no reply for a chat shared after the job's first check, refunding and counting nothing", async () => {
        const { linkId, threadId } = await seed();

        await start(linkId);
        probe.beforeStart = async () => {
            await harness.run(async (ctx: any) => {
                await ctx.db.patch("threads", threadId, { isPublic: true });
            });
        };
        await runJob(enqueued[0]!);

        const row = await rowOf(linkId);

        expect(probe.generated).toBe(0);
        expect(probe.charges).toBe(1);
        expect(probe.refunds).toBe(1);
        expect(row.watchWakeLeaseUntil).toBe(0);
        expect(row.watchWakeCompleted).toMatchObject({ done: true });
        expect(row.watchPending).toEqual(["checks"]);
        expect(row.watch.wakes).toBeUndefined();
        expect(row.watchWakeFailure).toMatchObject({ attempts: 0, kind: "shared" });
    });

    it.each([
        ["locked", { lockedAt: Date.now() }],
        ["being deleted", { deletingAt: Date.now() }],
    ])("asks no model for a chat that became %s in that window, with no failure counted", async (_name, patch) => {
        const { linkId, threadId } = await seed();

        await start(linkId);
        probe.beforeStart = async () => {
            await harness.run(async (ctx: any) => {
                await ctx.db.patch("threads", threadId, patch);
            });
        };
        await runJob(enqueued[0]!);

        const row = await rowOf(linkId);

        expect(probe.generated).toBe(0);
        expect(probe.refunds).toBe(1);
        expect(row.watchWakeLeaseUntil).toBe(0);
        expect(row.watch.wakes).toBeUndefined();
        expect(row.watchWakeFailure).toBeUndefined();
    });

    it("gives the reply when the chat is still the owner's alone", async () => {
        const { linkId } = await seed();

        await start(linkId);
        probe.beforeStart = async () => {
            // Nothing changed.
        };
        await runJob(enqueued[0]!);

        expect(probe.generated).toBe(1);
        expect(probe.refunds).toBe(0);
        const row = await rowOf(linkId);

        expect(row.watch.wakes).toBe(1);
    });
});

describe("the tools of a wake turn", () => {
    it("are only the pull request reads, passed to the headless run's tool builder", async () => {
        const { linkId } = await seed();

        await start(linkId);
        await runJob(enqueued[0]!);

        expect(runs[0]?.toolAllowlist).toEqual(WAKE_TOOL_ALLOWLIST);
        expect(runs[0]?.tools).toBe("headless");
    });

    it("leave no write tool and keep the reads: the built set, narrowed by that allowlist, refuses a write", async () => {
        const { applyToolAllowlist } = await import("../sub-agents/logic");
        const { PULL_REQUEST_TOOLS } = await import("../chat/lib/tool-builder");
        const { ToolName } = await import("../chat/tools");
        // What a run on a thread with a linked pull request would carry: every pull request tool, the watch tools, and others.
        const built = Object.fromEntries(
            [...PULL_REQUEST_TOOLS, ToolName.WebSearch, ToolName.ShellExecution, "someMcpTool"].map((name) => [name, { description: name }]),
        ) as never;
        const narrowed = applyToolAllowlist(built, WAKE_TOOL_ALLOWLIST);
        const names = Object.keys(narrowed);

        const byName = (left: string, right: string) => left.localeCompare(right);

        expect(names.toSorted(byName)).toEqual([ToolName.ReadFailingChecks, ToolName.ReadPullRequest].toSorted(byName));

        // Every write or state-changing tool is gone: a call to one finds no such tool.
        for (const write of [
            ToolName.ReplyToReviewComment,
            ToolName.RerunFailedChecks,
            ToolName.MergePullRequest,
            ToolName.WatchPullRequest,
            ToolName.UnwatchPullRequest,
            ToolName.ShellExecution,
            "someMcpTool",
        ]) {
            expect(narrowed[write]).toBeUndefined();
        }

        // The reads stay.
        expect(narrowed[ToolName.ReadPullRequest]).toBeDefined();
        expect(narrowed[ToolName.ReadFailingChecks]).toBeDefined();
    });
});

describe("what a failure before the first generation does to the charge", () => {
    const failing = (reference: unknown) => async (job: { args: Record<string, any>; options: Record<string, any> }) => {
        await harness
            .action(async (ctx: any) => {
                const real = ctx.runMutation.bind(ctx);

                ctx.runMutation = async (target: unknown, args: unknown) => {
                    if (target === reference) {
                        throw new Error("write failed");
                    }

                    return await real(target, args);
                };

                await ctx.runAction(runWatchWake, { ...job.args, jobId: job.options.once.jobId });
            })
            .catch(() => undefined);
    };

    it("refunds once when the write that keeps the charge fails, since generation never started", async () => {
        const { linkId } = await seed();

        await start(linkId);
        await failing(keepWatchWakeCharge)(enqueued[0]!);

        const row = await rowOf(linkId);

        expect(probe.charges).toBe(1);
        expect(probe.refunds).toBe(1);
        expect(row.watchWakeRefund).toMatchObject({ applied: true });
        expect(row.watch.wakes).toBeUndefined();
        expect(row.watchWakeFailure).toMatchObject({ attempts: 1 });
    });

    it("refunds once for a failure while the run is prepared (before its first generation step), and not twice by the lapse handler", async () => {
        const { linkId } = await seed();

        await start(linkId);
        probe.failBeforeModel = true;
        await runJob(enqueued[0]!);
        expect(probe.refunds).toBe(1);

        await harness.run(async (ctx: any) => await ctx.runMutation(releaseWatchWake, { ...key(linkId), claim: enqueued[0]!.args.claim, claimKey: "job-1" }));
        expect(probe.refunds).toBe(1);
    });

    it("keeps the charge for a failure after generation started", async () => {
        const { linkId } = await seed();

        await start(linkId);
        probe.fail = true;
        await runJob(enqueued[0]!);

        const row = await rowOf(linkId);

        expect(probe.charges).toBe(1);
        expect(probe.refunds).toBe(0);
        expect(row.watchWakeRefund).toMatchObject({ applied: true });
    });
});

describe("the model of a switched chat", () => {
    it("is the active agent's model, as a normal turn there uses", async () => {
        const { MODEL_LOOKUP } = await import("@neore/ai/models");
        const { isTaskModelAllowed } = await import("../tasks/logic");
        const ids = [...MODEL_LOOKUP.keys()];
        const switched = ids.find((id) => id !== MODEL && isTaskModelAllowed(id, (model) => MODEL_LOOKUP.get(model)));
        const { linkId, threadId } = await seed();

        await start(linkId);
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("threads", threadId, { activeAgent: { kind: "model", model: switched } });
        });
        await runJob(enqueued[0]!);

        expect(switched).toBeDefined();
        expect(runs[0]?.model).toBe(switched);
    });
});

describe("a refund owed by one claim", () => {
    it("is not paid by another claim's payment", async () => {
        const { linkId } = await seed({ watchWakeRefund: { applied: false, claim: 111, keys: ["chat/dailyText:premium"], windowEnds: [Date.now() + 60_000] } });
        const apply = async (claim: number) => await harness.run(async (ctx: any) => await ctx.runMutation(applyWatchWakeRefund, { claim, linkId }));

        await apply(222);
        expect(probe.refunds).toBe(0);
        await apply(111);
        await apply(111);
        expect(probe.refunds).toBe(1);
    });

    it("is paid before a terminal failure can stop the watch, once", async () => {
        const { linkId } = await seed();

        await start(linkId);
        probe.failBeforeModel = true;
        probe.failWith = new AgentRunErrorStandIn("terminal");
        // The job's own payment step fails, so the refund is still owed when the failure is settled.
        await harness
            .action(async (ctx: any) => {
                const real = ctx.runMutation.bind(ctx);

                ctx.runMutation = async (target: unknown, args: unknown) => {
                    if (target === applyWatchWakeRefund) {
                        throw new Error("refund failed");
                    }

                    return await real(target, args);
                };

                await ctx.runAction(runWatchWake, { ...enqueued[0]!.args, jobId: enqueued[0]!.options.once.jobId });
            })
            .catch(() => undefined);

        const row = await rowOf(linkId);

        expect(probe.refunds).toBe(1);
        expect(row.watchWakeRefund).toMatchObject({ applied: true });
        expect(row.watchActive).toBe(false);
        expect(row.watchWakeFailure).toMatchObject({ kind: "terminal" });
    });
});

describe("the model of the turn", () => {
    it("is the chat's model when the turn starts, not the copy made at the claim", async () => {
        const { MODEL_LOOKUP } = await import("@neore/ai/models");
        const { isTaskModelAllowed } = await import("../tasks/logic");
        const ids = [...MODEL_LOOKUP.keys()];
        const other = ids.find((id) => id !== MODEL && isTaskModelAllowed(id, (model) => MODEL_LOOKUP.get(model)));
        const { linkId, threadId } = await seed();

        await start(linkId);
        expect(enqueued[0]?.args.model).toBe(MODEL);
        expect(other).toBeDefined();

        // The owner changes the chat's model after the claim.
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("threads", threadId, { model: other });
        });
        await runJob(enqueued[0]!);

        expect(runs).toHaveLength(1);
        expect(runs[0]?.model).toBe(other);
    });

    it("refuses a model that is no longer available: nothing charged or counted, the lease released, the owner told once", async () => {
        const { linkId, threadId } = await seed();

        await start(linkId);
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("threads", threadId, { model: "retired-model-9000" });
        });
        await runJob(enqueued[0]!);

        const row = await rowOf(linkId);

        expect(runs).toHaveLength(0);
        expect(probe.charges).toBe(0);
        expect(row.watchWakeLeaseUntil).toBe(0);
        expect(row.watchPending).toEqual(["checks"]);
        expect(row.watch.wakes).toBeUndefined();
        expect(row.watchWakeCompleted).toBeUndefined();
        expect(row.watchWakeFailure).toMatchObject({ attempts: 0, kind: "unavailable", retryAt: 0 });

        // The claim now refuses it too: no lease and no job for a model that cannot run.
        const jobs = enqueued.length;

        expect(await start(linkId)).toBe(false);
        expect(enqueued).toHaveLength(jobs);
        expect(runs).toHaveLength(0);
    });
});

describe("an unavailable model at the claim", () => {
    it("enqueues nothing on repeated polls before the retry time, notes it once, and delivers once the model is allowed again", async () => {
        const { linkId, threadId } = await seed();

        await harness.run(async (ctx: any) => {
            await ctx.db.patch("threads", threadId, { model: "retired-model-9000" });
        });
        expect(await start(linkId)).toBe(false);

        const noted = await rowOf(linkId);

        expect(enqueued).toHaveLength(0);
        expect(noted.watchWakeLeaseUntil).toBeUndefined();
        expect(noted.watchPending).toEqual(["checks"]);
        expect(noted.watch.wakes).toBeUndefined();
        expect(noted.watchWakeFailure).toMatchObject({ attempts: 0, kind: "unavailable" });
        expect(noted.watchWakeFailure.retryAt).toBeGreaterThan(Date.now());

        // The polls before the retry time leave it alone: nothing enqueued, the note not rewritten.
        expect(await start(linkId)).toBe(false);
        expect(await start(linkId)).toBe(false);

        const again = await rowOf(linkId);

        expect(enqueued).toHaveLength(0);
        expect(again.watchWakeFailure.at).toBe(noted.watchWakeFailure.at);

        // The model is allowed again; past the retry time one job is enqueued and delivers.
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("threads", threadId, { model: MODEL });
        });
        vi.useFakeTimers({ now: noted.watchWakeFailure.retryAt + 1000, toFake: ["Date"] });

        try {
            expect(await start(linkId)).toBe(true);
            await runJob(enqueued[0]!);
        } finally {
            vi.useRealTimers();
        }

        expect(enqueued).toHaveLength(1);
        expect(runs).toHaveLength(1);
    });
});

describe("a turn fenced to its lease", () => {
    it("stops at the next step when its lease is replaced mid-turn, counting and charging nothing more, keeping the occurrence model-reached", async () => {
        const { linkId } = await seed();

        await start(linkId);

        const claim = enqueued[0]!.args.claim as number;

        probe.during = async () => {
            await harness.run(async (ctx: any) => {
                await ctx.db.patch("pullRequestThreads", linkId, { watchWakeLeaseUntil: claim + 12_345 });
            });
        };
        await runJob(enqueued[0]!);

        const row = await rowOf(linkId);

        expect(runs).toHaveLength(1);
        expect(probe.generated).toBe(1);
        expect(probe.charges).toBe(1);
        expect(row.watch.wakes).toBeUndefined();
        expect(row.watchPending).toEqual(["checks"]);
        expect(row.watchWakeFailure).toBeUndefined();
        // The newer claim's lease is not ours to release.
        expect(row.watchWakeLeaseUntil).toBe(claim + 12_345);
    });

    it("stops when the lease expires mid-turn: nothing counted, the lease released, the occurrence closed and model-reached", async () => {
        const { linkId } = await seed();

        await start(linkId);

        const claim = enqueued[0]!.args.claim as number;

        probe.during = async () => {
            vi.useFakeTimers({ now: claim + 1000, toFake: ["Date"] });
        };

        try {
            await runJob(enqueued[0]!);
        } finally {
            vi.useRealTimers();
        }

        const row = await rowOf(linkId);

        expect(row.watch.wakes).toBeUndefined();
        expect(row.watchPending).toEqual(["checks"]);
        expect(row.watchWakeFailure).toBeUndefined();
        expect(row.watchWakeLeaseUntil).toBe(0);
        expect(row.watchWakeCompleted).toMatchObject({ done: true, modelReached: true });
        expect(probe.refunds).toBe(0);
    });

    it("stops when the chat is locked mid-turn, and a turn whose lease holds runs to completion", async () => {
        const locked = await seed();

        await start(locked.linkId);
        probe.during = async () => {
            await harness.run(async (ctx: any) => {
                await ctx.db.patch("threads", locked.threadId, { lockedAt: Date.now() });
            });
        };
        await runJob(enqueued[0]!);

        const stopped = await rowOf(locked.linkId);

        expect(stopped.watch.wakes).toBeUndefined();
        expect(stopped.watchWakeLeaseUntil).toBe(0);

        probe.during = undefined;

        const whole = await seed();

        await start(whole.linkId);
        await runJob(enqueued.at(-1)!);

        const done = await rowOf(whole.linkId);

        expect(done.watch.wakes).toBe(1);
        expect(done.watchPending).toEqual([]);
    });
});

describe("the window a charge is recorded against", () => {
    it("is the earlier of the reads before and after the charge, so a rollover in between does not credit the new window", async () => {
        const { linkId } = await seed();

        await start(linkId);
        // The window rolled over between the charge and the later read: the later read names the new day's window.
        probe.endsBefore = [Date.now() + 1000, Date.now() + 1000];
        probe.endsAfter = [Date.now() + 86_400_000, Date.now() + 86_400_000];
        probe.windowReads = 0;
        await runJob(enqueued[0]!);

        // (the job completed: inspect the obligation the begin step wrote)
        const row = await rowOf(linkId);

        expect(row.watchWakeRefund.windowEnds).toEqual(probe.endsBefore);
    });
});

describe("a completion checkpoint that cannot be written", () => {
    it("still settles a delivered turn: counted once, the reasons cleared, and no second model run", async () => {
        const { linkId } = await seed();

        await start(linkId);
        await harness.action(async (ctx: any) => {
            const real = ctx.runMutation.bind(ctx);

            ctx.runMutation = async (reference: unknown, args: unknown) => {
                if (reference === completeWatchWake) {
                    throw new Error("checkpoint failed");
                }

                return await real(reference, args);
            };

            await ctx.runAction(runWatchWake, { ...enqueued[0]!.args, jobId: enqueued[0]!.options.once.jobId });
        });

        const row = await rowOf(linkId);

        expect(runs).toHaveLength(1);
        expect(row.watch.wakes).toBe(1);
        expect(row.watchPending).toEqual([]);
        expect(row.watchWakeCompleted).toMatchObject({ done: true, modelReached: true });
        expect(row.watchWakeLeaseUntil).toBe(0);

        // Nothing is owed or left to claim again: a later poll makes no second turn.
        expect(await start(linkId)).toBe(false);
        expect(runs).toHaveLength(1);
    });
});

describe("a commit that comes back after its wake was delivered", () => {
    it("is delivered again: the settled delivery no longer blocks the same markers, while a failed-after-model one still does", async () => {
        const { linkId } = await seed();

        await start(linkId);
        await runJob(enqueued[0]!);

        const delivered = await rowOf(linkId);

        expect(delivered.watchPending).toEqual([]);
        expect(delivered.watchWakeCompleted).toMatchObject({ done: true, state: "completed" });

        // The same failing head (sha-1) becomes a pending reason again, after the cooldown.
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("pullRequestThreads", linkId, { watchPending: ["checks"] });
        });
        vi.useFakeTimers({ now: Date.now() + PR_WATCH_WAKE_COOLDOWN_MS + 1000, toFake: ["Date"] });

        try {
            expect(await start(linkId)).toBe(true);
            await runJob(enqueued[1]!);
        } finally {
            vi.useRealTimers();
        }

        const again = await rowOf(linkId);

        expect(runs).toHaveLength(2);
        expect(again.watch.wakes).toBe(2);
    });
});

describe("a watch stopped or restarted during its turn", () => {
    it("fences a turn whose watch is stopped meanwhile: nothing counted, the lease released, the occurrence closed as model-reached", async () => {
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
        expect(row.watch.wakes).toBeUndefined();
        expect(row.watchWakeLeaseUntil).toBe(0);
        expect(row.watchWakeCompleted).toMatchObject({ done: true, modelReached: true });
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
            probe.failBeforeModel = true;
            await harness.action(
                async (ctx: any) => await ctx.runAction(runWatchWake, { ...enqueued.at(-1)!.args, jobId: enqueued.at(-1)!.options.once.jobId }),
            );
            probe.failBeforeModel = false;
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
