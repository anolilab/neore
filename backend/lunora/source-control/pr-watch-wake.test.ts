/**
 * The wake turn (`pr-watch-wake.ts`): the scheduled step only claims, charges and enqueues; the job runs the turn, and only then
 * the wake is counted and the delivered occurrences cleared. A failed or over-limit turn leaves the reasons pending. The agent run,
 * the jobs queue and the daily charge are faked; claim, finish and the poller's record are the real procedures.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { insertThread } from "../agent/table-writes";
import schema from "../schema";
import { PR_WATCH_MAX_WAKES, PR_WATCH_WAKE_COOLDOWN_MS } from "./pr-watch-logic";

const { enqueued, probe, registry, runs } = vi.hoisted(() => {
    return {
        enqueued: [] as { args: Record<string, any>; options: Record<string, any> }[],
        probe: { allowRound: true, anonymous: false, charges: 0, fail: false },
        registry: new Map<string, unknown>(),
        runs: [] as Record<string, any>[],
    };
});

vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

vi.mock("../lib/job-queue", () => {
    return {
        enqueueJob: async (_ref: unknown, args: Record<string, any>, options: Record<string, any>) => {
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
            return { isAdmin: false, isAnonymous: probe.anonymous, tier: "free" as const };
        },
    };
});

vi.mock("../chat/lib/headless-run", () => {
    return {
        runHeadlessAgent: async (_ctx: unknown, options: Record<string, any>) => {
            runs.push(options);

            if (probe.fail) {
                throw new Error("run failed");
            }

            return { text: "ok", threadId: options.thread.threadId };
        },
    };
});

const { finishWatchWake, isWatchWakeCurrent, PR_WATCH_WAKE_LEASE_MS, releaseWatchWake, runWatchWake, startWatchWake, wakePrompt } =
    await import("./pr-watch-wake");
const { recordWatchObservation } = await import("./pr-watch-poll");
const { JOB_LEASE_MS } = await import("../lib/job-once");

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
    probe.fail = false;
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
const start = async (linkId: string, args: Record<string, unknown> = {}): Promise<boolean> =>
    await harness.run(async (ctx: any) => await ctx.runMutation(startWatchWake, { ...key(linkId), ...args }));
/** The job as the queue would run it: the args the scheduled step enqueued. */
const runJob = async (job: { args: Record<string, any> }): Promise<void> => {
    await harness.action(async (ctx: any) => await ctx.runAction(runWatchWake, job.args));
};

describe("the scheduled step", () => {
    it("only claims, charges one round and enqueues the turn on the jobs queue: it runs no model", async () => {
        const { linkId, threadId } = await seed();

        expect(await start(linkId)).toBe(true);

        const row = await rowOf(linkId);

        expect(runs).toHaveLength(0);
        expect(probe.charges).toBe(1);
        expect(enqueued).toHaveLength(1);
        expect(enqueued[0]?.args).toMatchObject({ linkId, model: "gpt-4o", reasons: ["checks"], threadId, userId: OWNER });
        expect(enqueued[0]?.options).toMatchObject({ once: { userId: OWNER }, shardKey: OWNER });
        expect(row.watchWakeLeaseUntil).toBe(enqueued[0]?.args.claim);
        // Nothing is counted or cleared until the turn ran.
        expect(row.watchPending).toEqual(["checks"]);
        expect(row.watch.wakes).toBeUndefined();
    });

    it("does not run, charge or count when a daily limit is spent, and leaves the reasons pending for the next poll", async () => {
        const { linkId } = await seed();

        probe.allowRound = false;

        expect(await start(linkId)).toBe(false);

        const row = await rowOf(linkId);

        expect(enqueued).toHaveLength(0);
        expect(runs).toHaveLength(0);
        expect(row.watchWakeLeaseUntil).toBeUndefined();
        expect(row.watchPending).toEqual(["checks"]);
        expect(row.watch.wakes).toBeUndefined();

        // Within the limit again, the next poll's delivery goes ahead.
        probe.allowRound = true;
        expect(await start(linkId)).toBe(true);
    });

    it("refuses an account that may not run unattended turns", async () => {
        const { linkId } = await seed();

        probe.anonymous = true;

        expect(await start(linkId)).toBe(false);
        expect(probe.charges).toBe(0);
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

    it("reports whether a delivery still holds the lease", async () => {
        const { linkId } = await seed({ watchWakeLeaseUntil: 9000 });
        const current = async (claim: number) => await harness.run(async (ctx: any) => await ctx.runQuery(isWatchWakeCurrent, { ...key(linkId), claim }));

        expect(await current(9000)).toBe(true);
        expect(await current(1)).toBe(false);
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
