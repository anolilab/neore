/**
 * The wake turn (`pr-watch-wake.ts`): claimed once, run in the linked thread, counted and cleared only after it ran, and left
 * pending when it fails. The agent run is faked; claim, finish and the poller's record are the real procedures.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { insertThread } from "../agent/table-writes";
import schema from "../schema";
import { PR_WATCH_MAX_WAKES, PR_WATCH_WAKE_COOLDOWN_MS } from "./pr-watch-logic";

const { probe, registry, runs } = vi.hoisted(() => {
    return {
        probe: { fail: false },
        registry: new Map<string, unknown>(),
        runs: [] as Record<string, any>[],
    };
});

vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

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

const { claimWatchWake, deliverWatchWake, finishWatchWake, wakePrompt } = await import("./pr-watch-wake");
const { recordWatchObservation } = await import("./pr-watch-poll");

const OWNER = "user-a";
const STARTED_AT = 1000;
const LEASE = 5000;

let harness: ReturnType<typeof lunoraTest>;

beforeAll(async () => {
    registerModule(registry, "source_control_pr_watch_wake", await import("./pr-watch-wake"));
});

beforeEach(() => {
    runs.length = 0;
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
            watch: { baselined: true, headSha: "sha-1", startedAt: STARTED_AT },
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
const deliver = async (linkId: string): Promise<void> => {
    await harness.action(async (ctx: any) => await ctx.runAction(deliverWatchWake, key(linkId)));
};

describe("deliverWatchWake", () => {
    it("runs one turn in the linked thread, then counts the wake once and clears what it delivered", async () => {
        const { linkId, threadId } = await seed();

        await deliver(linkId);

        const row = await rowOf(linkId);

        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ model: "gpt-4o", organizationId: null, origin: "trigger", thread: { threadId }, tools: "headless", userId: OWNER });
        expect(runs[0]?.prompt).toBe(wakePrompt({ number: 7, repository: "octo/hello" }, ["checks"]));
        expect(row.watchPending).toEqual([]);
        expect(row.watch).toMatchObject({ wakes: 1 });
        expect(row.watch.lastWakeAt).toBeGreaterThan(0);
        expect(row.watchWakeLeaseUntil).toBe(0);
    });

    it("keeps the reasons pending and the count where it was when the turn fails", async () => {
        const { linkId } = await seed({ watch: { baselined: true, startedAt: STARTED_AT, wakes: 2 } });

        probe.fail = true;
        await deliver(linkId);

        const row = await rowOf(linkId);

        expect(runs).toHaveLength(1);
        expect(row.watchPending).toEqual(["checks"]);
        expect(row.watch.wakes).toBe(2);
        expect(row.watch.lastWakeAt).toBeUndefined();
        expect(row.watchWakeLeaseUntil).toBe(0);

        // Released: a later try delivers.
        probe.fail = false;
        await deliver(linkId);

        const again = await rowOf(linkId);

        expect(again.watch.wakes).toBe(3);
    });

    it("delivers nothing while another delivery holds the lease", async () => {
        const { linkId } = await seed({ watchWakeLeaseUntil: Date.now() + 60_000 });

        await deliver(linkId);

        expect(runs).toHaveLength(0);
    });
});

describe("claimWatchWake", () => {
    const claim = async (linkId: string, args: Record<string, unknown> = {}) =>
        await harness.run(async (ctx: any) => await ctx.runMutation(claimWatchWake, { ...key(linkId), ...args }));

    it("refuses at the cap of wakes, inside the cooldown, with nothing pending, and for another run or start", async () => {
        const capped = await seed({ watch: { baselined: true, startedAt: STARTED_AT, wakes: PR_WATCH_MAX_WAKES } });
        const cooling = await seed({ watch: { baselined: true, lastWakeAt: Date.now() - PR_WATCH_WAKE_COOLDOWN_MS / 2, startedAt: STARTED_AT, wakes: 1 } });
        const empty = await seed({ watchPending: [] });
        const live = await seed();

        expect(await claim(capped.linkId)).toBeNull();
        expect(await claim(cooling.linkId)).toBeNull();
        expect(await claim(empty.linkId)).toBeNull();
        expect(await claim(live.linkId, { run: "run-2" })).toBeNull();
        expect(await claim(live.linkId, { startedAt: STARTED_AT + 1 })).toBeNull();
        const taken = await claim(live.linkId);

        expect(taken).toMatchObject({ reasons: ["checks"], repository: "octo/hello" });
    });

    it("refuses a stopped watch, a locked thread and a thread that is streaming a reply", async () => {
        const stopped = await seed({ watch: { baselined: true, startedAt: STARTED_AT, stoppedAt: 2000 }, watchActive: false });
        const locked = await seed({}, { lockedAt: Date.now() });
        const busy = await seed();

        await harness.run(async (ctx: any) => {
            await ctx.db.persistentStreams.insert({ status: "streaming", threadId: busy.threadId });
        });

        expect(await claim(stopped.linkId)).toBeNull();
        expect(await claim(locked.linkId)).toBeNull();
        expect(await claim(busy.linkId)).toBeNull();
    });

    it("hands the lease to one claimant only", async () => {
        const { linkId } = await seed();

        expect(await claim(linkId)).not.toBeNull();
        expect(await claim(linkId)).toBeNull();
    });
});

describe("finishWatchWake", () => {
    it("clears only the delivered reasons, and ignores a claim that is no longer the lease", async () => {
        const { linkId } = await seed({ watchPending: ["checks", "review"], watchWakeLeaseUntil: 9000 });
        const finish = async (claim: number) =>
            await harness.run(async (ctx: any) => await ctx.runMutation(finishWatchWake, { ...key(linkId), claim, delivered: true, reasons: ["checks"] }));

        await finish(1);
        const untouched = await rowOf(linkId);

        expect(untouched.watch.wakes).toBeUndefined();

        await finish(9000);

        const row = await rowOf(linkId);

        expect(row.watchPending).toEqual(["review"]);
        expect(row.watch.wakes).toBe(1);
    });
});

describe("the poller's record of a wake", () => {
    it("schedules one delivery, and sends nothing itself", async () => {
        const { linkId } = await seed({ watchPending: [] });
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

        const jobs = (harness.scheduler.list() as unknown as { args: Record<string, unknown>; functionPath?: string }[]).slice(before);

        // The delivery is the one job that carries the watch's start and run.
        expect(jobs.filter((job) => job.args.startedAt === STARTED_AT && job.args.run === "run-1")).toHaveLength(1);
        expect(runs).toHaveLength(0);
        const row = await rowOf(linkId);

        expect(row.watchPending).toEqual(["checks"]);
    });
});
