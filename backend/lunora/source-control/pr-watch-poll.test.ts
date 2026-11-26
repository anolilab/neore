/**
 * The watch poller's records (`pr-watch-poll.ts`): the sweep leases only due running watches, and an observation is
 * recorded exactly as `decideWatch` says, only while its lease and its watch are still current.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setPullRequestWatch } from "./pr-watch";
import { insertThread } from "../agent/table-writes";
import { runInShard } from "../lib/shard-context";
import schema from "../schema";
import {
    PR_WATCH_LEASE_MS,
    PR_WATCH_POLL_INTERVAL_MS,
    checksOf,
    dispatchDueWatches,
    observeWatched,
    pollWatchLink,
    readWatchForPoll,
    recordWatchFailure,
    recordWatchObservation,
    runWatchPoll,
} from "./pr-watch-poll";
import type { CheckRun } from "./types";
import { decideWatch, PR_WATCH_MAX_WAKES, PR_WATCH_WAKE_COOLDOWN_MS, stateOf, storedWatchOf } from "./pr-watch-logic";
import type { PullRequestObservation } from "./pr-watch-logic";

const OWNER = "user-a";
const STARTED_AT = 1000;
const LEASE = 5000;

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const observation = (extra: Partial<PullRequestObservation> = {}): PullRequestObservation => {
    return { checks: "passing", failingCheckNames: [], headSha: "sha-1", mergeable: "clean", reviews: [], state: "open", watcherLogin: "me", ...extra };
};

/** A running watch (unless `extra` says otherwise) on a link of `OWNER`. Returns the link's id. */
const seedWatch = async (extra: Record<string, unknown> = {}, number = 7): Promise<string> =>
    await harness.run(async (ctx: any) => {
        const threadId = await insertThread(ctx.db, {
            createdBy: OWNER,
            mode: "text",
            status: "active",
            tags: ["chat"],
            title: "work",
            updatedAt: Date.now(),
            userId: OWNER,
        });

        return String(
            await ctx.db.insert("pullRequestThreads", {
                createdAt: 0,
                kind: "linked",
                number,
                repository: "octo/hello",
                threadId,
                title: "pull",
                url: `https://github.com/octo/hello/pull/${String(number)}`,
                userId: OWNER,
                watch: { startedAt: STARTED_AT },
                watchActive: true,
                watchCheckedAt: LEASE,
                ...extra,
            }),
        );
    });

const watchField = async (linkId: string, path: string): Promise<any> => {
    const row = await rowOf(linkId);

    let value: any = row;

    for (const key of path.split(".")) {
        value = value?.[key];
    }

    return value;
};

const rowOf = async (linkId: string): Promise<any> => await harness.run(async (ctx: any) => await ctx.db.get("pullRequestThreads", linkId));

const pollLink = async (linkId: string): Promise<void> => {
    await harness.run(async (ctx: any) => {
        await ctx.runMutation(pollWatchLink, { linkId });
    });
};

const record = async (linkId: string, args: { lease?: number; observation: PullRequestObservation; run?: string; startedAt?: number }): Promise<void> => {
    await harness.run(async (ctx: any) => {
        await ctx.runMutation(recordWatchObservation, { lease: LEASE, linkId, startedAt: STARTED_AT, ...args });
    });
};

const check = (name: string, state: CheckRun["state"], required: boolean | null = true): CheckRun => {
    return { id: null, name, required, state, url: null };
};

describe("checksOf", () => {
    it("is pending, not passing, while a required check has not reported", () => {
        const summary = { checks: [check("build", "success")], required: { complete: true, patterns: ["build", "lint"] }, total: 1 };

        expect(checksOf(summary).status).toBe("pending");
    });

    it("is pending while the host holds more checks than were listed", () => {
        const summary = { checks: [check("build", "success")], required: { complete: true, patterns: ["build"] }, total: 40 };

        expect(checksOf(summary).status).toBe("pending");
    });

    it("is failing, with the names, when a reported check failed, even with another required check missing", () => {
        const summary = {
            checks: [check("build", "failure"), check("docs", "failure", false), check("test", "success")],
            required: { complete: true, patterns: ["build", "test", "lint"] },
            total: 3,
        };

        expect(checksOf(summary)).toMatchObject({ failing: [{ name: "build" }], status: "failing" });
    });

    it("is passing only when every required check reported and passed", () => {
        const summary = {
            checks: [check("build", "success"), check("lint", "success"), check("docs", "pending", false)],
            required: { complete: true, patterns: ["build", "lint"] },
            total: 3,
        };

        expect(checksOf(summary)).toEqual({ failing: [], status: "passing" });
    });

    it("is pending while a required check is still running", () => {
        const summary = { checks: [check("build", "pending")], required: { complete: true, patterns: ["build"] }, total: 1 };

        expect(checksOf(summary).status).toBe("pending");
    });
});

describe("dispatchDueWatches", () => {
    it("leases a watch never read, and skips one read inside the interval", async () => {
        const fresh = await seedWatch({ watchCheckedAt: Date.now() }, 1);
        const never = await seedWatch({ watchCheckedAt: undefined }, 2);
        const old = await seedWatch({ watchCheckedAt: Date.now() - PR_WATCH_POLL_INTERVAL_MS - 1000 }, 3);
        const before = await watchField(fresh, "watchCheckedAt");
        const result = await harness.run(async (ctx: any) => await runInShard(OWNER, () => ctx.runMutation(dispatchDueWatches, {})));

        expect(result.dispatched).toBe(2);
        expect(await watchField(fresh, "watchCheckedAt")).toBe(before);
        expect(await watchField(never, "watchCheckedAt")).toBeGreaterThan(0);
        expect(await watchField(old, "watchCheckedAt")).toBeGreaterThan(Date.now() - PR_WATCH_POLL_INTERVAL_MS);
    });

    it("skips a stopped watch and a watch on a deleted thread", async () => {
        await seedWatch({ watch: { startedAt: STARTED_AT, stoppedAt: 2000 }, watchActive: false, watchCheckedAt: undefined }, 1);
        await seedWatch({ threadDeleted: true, watchCheckedAt: undefined }, 2);

        const result = await harness.run(async (ctx: any) => await runInShard(OWNER, () => ctx.runMutation(dispatchDueWatches, {})));

        expect(result.dispatched).toBe(0);
    });

    it("reaches an older due watch behind many that are not due", async () => {
        const recent = Date.now();

        for (let number = 1; number <= 24; number += 1) {
            await seedWatch({ watchCheckedAt: recent }, number);
        }

        const due = await seedWatch({ watchCheckedAt: undefined }, 25);
        const result = await harness.run(async (ctx: any) => await runInShard(OWNER, () => ctx.runMutation(dispatchDueWatches, {})));
        const { watchCheckedAt } = await rowOf(due);

        expect(result.dispatched).toBe(1);
        expect(watchCheckedAt).toBeGreaterThan(0);
    });

    it("takes a bounded number of watches per sweep", async () => {
        for (let number = 1; number <= 12; number += 1) {
            await seedWatch({ watchCheckedAt: undefined }, number);
        }

        const result = await harness.run(async (ctx: any) => await runInShard(OWNER, () => ctx.runMutation(dispatchDueWatches, {})));

        expect(result.dispatched).toBe(10);
    });
});

describe("pollWatchLink", () => {
    const run = pollLink;

    it("leases a due watch and arms its next poll, with no sweep and no shard activity", async () => {
        const linkId = await seedWatch({ watchCheckedAt: undefined });
        const before = harness.scheduler.list().length;

        await run(linkId);

        const jobs = harness.scheduler.list().slice(before) as unknown as { args: Record<string, unknown> }[];
        const { watchCheckedAt: lease } = await rowOf(linkId);

        expect(jobs).toHaveLength(2);
        expect(jobs.some((job) => job.args.lease === lease && job.args.startedAt === STARTED_AT)).toBe(true);
        expect(jobs.some((job) => job.args.lease === undefined && job.args.linkId === linkId)).toBe(true);
    });

    it("does nothing for a watch read inside the interval, a stopped watch or a missing link", async () => {
        const fresh = await seedWatch({ watchCheckedAt: Date.now() }, 1);
        const stopped = await seedWatch({ watch: { startedAt: STARTED_AT, stoppedAt: 2000 }, watchActive: false, watchCheckedAt: undefined }, 2);
        const before = harness.scheduler.list().length;

        await run(fresh);
        await run(stopped);

        expect(harness.scheduler.list()).toHaveLength(before);
    });
});

describe("a poll that takes longer than the interval", () => {
    const START = 2_000_000_000_000;

    afterEach(() => {
        vi.useRealTimers();
    });

    const jobs = (): { enqueuedAt: number; functionPath?: string; scheduledFor: number }[] => harness.scheduler.list() as never;

    it("keeps its lease, records its observation, and the next poll waits for the lease to end", async () => {
        vi.useFakeTimers({ now: START, toFake: ["Date"] });

        const linkId = await seedWatch({ watchCheckedAt: undefined, watchLeaseUntil: undefined });
        const run = async (): Promise<void> => await pollLink(linkId);

        await run();

        const { watchCheckedAt: lease } = await rowOf(linkId);
        const afterLease = jobs().length;

        // Leased now; the read is slow. Past the interval, neither the poll chain nor the sweep may start another one.
        vi.setSystemTime(START + PR_WATCH_POLL_INTERVAL_MS + 60_000);
        await run();

        const swept = await harness.run(async (ctx: any) => await runInShard(OWNER, () => ctx.runMutation(dispatchDueWatches, {})));

        expect(swept.dispatched).toBe(0);
        expect(jobs()).toHaveLength(afterLease);
        const held = await rowOf(linkId);

        expect(held.watchCheckedAt).toBe(lease);

        // The slow read lands: its record applies, releases the lease and arms the next poll one interval after the record.
        const recordedAt = START + PR_WATCH_POLL_INTERVAL_MS + 60_000;

        await record(linkId, { lease, observation: observation({ headSha: "sha-slow" }) });

        const row = await rowOf(linkId);
        // Each job's delay is its own scheduledFor minus its own enqueuedAt, so no clock is compared with another.
        const delays = (list: { enqueuedAt: number; scheduledFor: number }[]) => list.map((job) => job.scheduledFor - job.enqueuedAt);
        const armed = delays(jobs().slice(afterLease) as never);

        expect(row.watch).toMatchObject({ baselined: true, headSha: "sha-slow" });
        expect(row.watchLeaseUntil).toBe(recordedAt + PR_WATCH_POLL_INTERVAL_MS);
        expect(jobs()).toHaveLength(afterLease + 1);
        expect(armed).toEqual([PR_WATCH_POLL_INTERVAL_MS]);

        // The watchdog armed with the lease sits a whole lease away, so it cannot start a poll inside the read.
        expect(delays(jobs().slice(0, afterLease) as never)).toContain(PR_WATCH_LEASE_MS);

        // Before that interval ends nothing is leased; after it, the watch is polled again.
        await run();
        expect(jobs()).toHaveLength(afterLease + 1);

        vi.setSystemTime(recordedAt + PR_WATCH_POLL_INTERVAL_MS);
        await run();
        expect(jobs().length).toBeGreaterThan(afterLease + 1);
    });
});

describe("a poll that went stale before the host read", () => {
    const TARGET = { number: 7, repository: "octo/hello", userId: OWNER };
    const TOKEN = {
        accessToken: "t",
        renew: async () => {
            return { accessToken: "t" };
        },
    } as never;
    const key = (linkId: string) => {
        return { lease: LEASE, linkId, startedAt: STARTED_AT };
    };

    const readFor = async (linkId: string, override: Record<string, unknown> = {}) =>
        await harness.run(async (ctx: any) => await ctx.runQuery(readWatchForPoll, { ...key(linkId), ...override }));

    it("reads as null once the watch is stopped, the lease moved or the watch restarted", async () => {
        const live = await seedWatch();

        expect(await readFor(live)).toMatchObject({ number: 7, repository: "octo/hello" });
        expect(await readFor(live, { lease: LEASE + 1 })).toBeNull();
        expect(await readFor(live, { startedAt: STARTED_AT + 1 })).toBeNull();

        const stopped = await seedWatch({ watch: { startedAt: STARTED_AT, stoppedAt: 2000 }, watchActive: false }, 2);

        expect(await readFor(stopped)).toBeNull();
    });

    it("makes no host call when the watch was stopped while the token was fetched", async () => {
        const readHost = vi.fn();
        const saved = vi.fn();
        const read = vi.fn().mockResolvedValueOnce(TARGET).mockResolvedValueOnce(null);

        await runWatchPoll({ fail: vi.fn(), read, readHost, record: saved, token: async () => TOKEN });

        expect(read).toHaveBeenCalledTimes(2);
        expect(readHost).not.toHaveBeenCalled();
        expect(saved).not.toHaveBeenCalled();
    });

    it("makes no host call for a watch already stopped, and none for a token it never asked for", async () => {
        const readHost = vi.fn();
        const token = vi.fn();

        await runWatchPoll({ fail: vi.fn(), read: async () => null, readHost, record: vi.fn(), token });

        expect(token).not.toHaveBeenCalled();
        expect(readHost).not.toHaveBeenCalled();
    });

    it("reads the host and records the observation while the watch is still current", async () => {
        const answer = observation();
        const readHost = vi.fn().mockResolvedValue({ observation: answer, status: "ok" });
        const saved = vi.fn();

        await runWatchPoll({ fail: vi.fn(), read: async () => TARGET, readHost, record: saved, token: async () => TOKEN });

        expect(readHost).toHaveBeenCalledOnce();
        expect(saved).toHaveBeenCalledWith(answer);
    });

    it("retries only the record, with the same observation, when it throws once", async () => {
        const failing = observation({ checks: "failing", failingCheckNames: ["build"] });
        const readHost = vi.fn().mockResolvedValue({ observation: failing, status: "ok" });
        const saved = vi.fn().mockRejectedValueOnce(new Error("write failed")).mockResolvedValue(null);

        await runWatchPoll({ fail: vi.fn(), read: async () => TARGET, readHost, record: saved, token: async () => TOKEN });

        expect(readHost).toHaveBeenCalledOnce();
        expect(saved).toHaveBeenCalledTimes(2);
        expect(saved).toHaveBeenNthCalledWith(2, failing);
    });

    it("gives up after the bound without a second host read, and does not take it for a failed read", async () => {
        const readHost = vi.fn().mockResolvedValue({ observation: observation(), status: "ok" });
        const saved = vi.fn().mockRejectedValue(new Error("write failed"));
        const failed = vi.fn();

        await expect(runWatchPoll({ fail: failed, read: async () => TARGET, readHost, record: saved, token: async () => TOKEN })).rejects.toThrow(
            "write failed",
        );

        expect(saved).toHaveBeenCalledTimes(3);
        expect(readHost).toHaveBeenCalledOnce();
        expect(failed).not.toHaveBeenCalled();
    });

    it("stores the first read's failing checks when a retried record lands after the host turned green", async () => {
        const linkId = await seedWatch({ watch: { baselined: true, headSha: "sha-1", startedAt: STARTED_AT } });
        const failing = observation({ checks: "failing", failingCheckNames: ["build"] });
        let tries = 0;

        await runWatchPoll({
            fail: vi.fn(),
            read: async () => TARGET,
            // A second host read would answer passing; the poll must not make one.
            readHost: vi.fn().mockResolvedValueOnce({ observation: failing, status: "ok" }).mockResolvedValue({ observation: observation(), status: "ok" }),
            record: async (observed) => {
                tries += 1;

                if (tries === 1) {
                    throw new Error("write failed");
                }

                await record(linkId, { observation: observed });
            },
            token: async () => TOKEN,
        });

        const row = await rowOf(linkId);

        expect(row.watchPending).toEqual(["checks"]);
        expect(row.watch.checksHeadSha).toBe("sha-1");
    });

    it("notes a failed host read and records nothing else", async () => {
        const saved = vi.fn();
        const failed = vi.fn();

        await runWatchPoll({
            fail: failed,
            read: async () => TARGET,
            readHost: async () => {
                return { status: "rate_limited" };
            },
            record: saved,
            token: async () => TOKEN,
        });

        expect(saved).not.toHaveBeenCalled();
        expect(failed).toHaveBeenCalledExactlyOnceWith("rate_limited");
    });

    it("logs one event for a failed read, counts the attempts and leaves the watch state unchanged", async () => {
        const watch = { baselined: true, headSha: "sha-1", startedAt: STARTED_AT, wakes: 2 };
        const linkId = await seedWatch({ watch, watchPending: ["checks"] });
        const event = vi.fn();
        const fail = async (status: string) => {
            await harness.run(async (ctx: any) => {
                ctx.log.event = event;
                await ctx.db.patch("pullRequestThreads", linkId, { watchCheckedAt: LEASE });
                await ctx.runMutation(recordWatchFailure, { ...key(linkId), status });
            });
        };

        await fail("rate_limited");
        await fail("host_error");

        const row = await rowOf(linkId);

        expect(row.watch).toEqual(watch);
        expect(row.watchPending).toEqual(["checks"]);
        expect(row.watchActive).toBe(true);
        expect(row.watchCheckedAt).toBe(-1);
        expect(row.watchReadFailure).toMatchObject({ attempts: 2, status: "host_error" });
        expect(event).toHaveBeenCalledTimes(2);
        expect(event).toHaveBeenLastCalledWith("develop.watch_poll_failed", { attempt: 2, linkId, status: "host_error" });
    });

    it("ignores a failure for a stale lease, and a landed read clears the failure", async () => {
        const linkId = await seedWatch({ watch: { baselined: true, startedAt: STARTED_AT }, watchReadFailure: { at: 1, attempts: 3, status: "host_error" } });

        await harness.run(async (ctx: any) => {
            await ctx.runMutation(recordWatchFailure, { ...key(linkId), lease: LEASE + 1, status: "not_found" });
        });
        const stale = await rowOf(linkId);

        expect(stale.watchReadFailure.attempts).toBe(3);

        await record(linkId, { observation: observation() });
        const cleared = await rowOf(linkId);

        expect(cleared.watchReadFailure.attempts).toBe(0);
    });
});

describe("observeWatched", () => {
    const TARGET = { number: 7, repository: "octo/hello", userId: OWNER };
    const request = (async () => new Response()) as never;
    const detail = (state: "closed" | "merged" | "open") => {
        return { headSha: "sha-1", mergeState: "clean", state };
    };

    it.each(["closed", "merged"] as const)("makes no login call and reads nothing else for a %s pull request", async (state) => {
        const login = vi.fn();
        const driver = { getPullRequest: vi.fn().mockResolvedValue(detail(state)), listChecks: vi.fn(), listReviews: vi.fn() };
        const { observation: observed } = await observeWatched(request, TARGET, { driver: driver as never, login });

        expect(observed.state).toBe(state);
        expect(login).not.toHaveBeenCalled();
        expect(driver.listChecks).not.toHaveBeenCalled();
        expect(driver.listReviews).not.toHaveBeenCalled();
    });

    it("records the end of a closed pull request through the mutation", async () => {
        const linkId = await seedWatch({ watch: { baselined: true, headSha: "sha-1", startedAt: STARTED_AT } });
        const driver = { getPullRequest: vi.fn().mockResolvedValue(detail("closed")), listChecks: vi.fn(), listReviews: vi.fn() };
        const { observation: observed } = await observeWatched(request, TARGET, { driver: driver as never, login: vi.fn() });

        await record(linkId, { observation: observed });

        const row = await rowOf(linkId);

        expect(row.watchActive).toBe(false);
        expect(row.watch.stoppedAt).toBeGreaterThan(0);
    });

    it("keeps the newest reviews when the host lists more than the bound: a new one at the top wakes the watch", async () => {
        const items = Array.from({ length: 120 }, (_, index) => {
            return { authorLogin: "bob", id: `r${String(120 - index)}` };
        });
        const driver = {
            getPullRequest: vi.fn().mockResolvedValue(detail("open")),
            listChecks: vi.fn().mockResolvedValue({ checks: [], required: { complete: true, patterns: [] }, total: 0 }),
            listReviews: vi.fn().mockResolvedValue({ items, total: 120 }),
        };
        const { observation: observed } = await observeWatched(request, TARGET, { driver: driver as never, login: async () => "me" });

        expect(observed.reviews[0]?.id).toBe("r120");
        expect(observed.reviews.length).toBeLessThanOrEqual(120);

        const decision = decideWatch({ baselined: true, headSha: "sha-1", reviewId: "r119" }, observed, Date.now());

        expect(decision).toMatchObject({ action: "wake", reasons: ["review"], state: { reviewId: "r120" } });
    });

    const dependencies = (items: { authorLogin: string; id: string }[], total: number) => {
        return {
            driver: {
                getPullRequest: vi.fn().mockResolvedValue(detail("open")),
                listChecks: vi.fn().mockResolvedValue({ checks: [], required: { complete: true, patterns: [] }, total: 0 }),
                listReviews: vi.fn().mockResolvedValue({ items, total }),
            } as never,
            login: async () => "me",
        };
    };

    it("keeps the seen review and every newer one past the bound, so the poll records a review wake", async () => {
        const items = Array.from({ length: 150 }, (_, index) => {
            return { authorLogin: "bob", id: String(150 - index) };
        });
        const linkId = await seedWatch({ watch: { baselined: true, headSha: "sha-1", reviewId: "10", startedAt: STARTED_AT } });
        const { observation: observed } = await observeWatched(request, { ...TARGET, reviewId: "10" }, dependencies(items, 150));

        expect(observed.reviews).toHaveLength(141);
        expect(observed.reviews.at(-1)?.id).toBe("10");

        await record(linkId, { observation: observed });

        const row = await rowOf(linkId);

        expect(row.watchPending).toEqual(["review"]);
        expect(row.watch.reviewId).toBe("150");
    });

    it("wakes for a review when the seen review lies beyond what the host read", async () => {
        const items = Array.from({ length: 150 }, (_, index) => {
            return { authorLogin: "bob", id: String(400 - index) };
        });
        const linkId = await seedWatch({ watch: { baselined: true, headSha: "sha-1", reviewId: "10", startedAt: STARTED_AT } });
        const { observation: observed } = await observeWatched(request, { ...TARGET, reviewId: "10" }, dependencies(items, 400));

        await record(linkId, { observation: observed });

        const row = await rowOf(linkId);

        expect(observed.reviewsTruncated).toBe(true);
        expect(row.watch.reviewId).toBe("400");
        expect(row.watchPending).toEqual(["review"]);
    });

    it("reads the login once for a watch that goes on", async () => {
        const login = vi.fn().mockResolvedValue("me");
        const driver = {
            getPullRequest: vi.fn().mockResolvedValue(detail("open")),
            listChecks: vi.fn().mockResolvedValue({ checks: [], required: { complete: true, patterns: [] }, total: 0 }),
            listReviews: vi.fn().mockResolvedValue({ items: [{ authorLogin: "bob", id: "r1" }], total: 1 }),
        };
        const { observation: observed } = await observeWatched(request, TARGET, { driver: driver as never, login });

        expect(login).toHaveBeenCalledOnce();
        expect(observed).toMatchObject({ checks: "passing", mergeable: "clean", reviews: [{ authorLogin: "bob", id: "r1" }], watcherLogin: "me" });
    });
});

describe("a poll taken before a stop and restart", () => {
    it("does not record after the restart, even with the same start time", async () => {
        const stoppedWatch = { baselined: true, headSha: "sha-1", startedAt: STARTED_AT };
        const linkId = await seedWatch({ watch: stoppedWatch, watchRun: "run-1" });
        const { threadId: linkThread } = await rowOf(linkId);
        const threadId = String(linkThread);

        // The same poll's identity as it was leased: same start time, same lease, the first run.
        const stale = { lease: LEASE, run: "run-1" };

        await harness.run(async (ctx: any) => {
            await ctx.runMutation(setPullRequestWatch, { number: 7, repository: "octo/hello", threadId, userId: OWNER, watching: false });
            await ctx.runMutation(setPullRequestWatch, { number: 7, repository: "octo/hello", threadId, userId: OWNER, watching: true });
            // Force the restart's start time and lease to the old values, the worst case for a clock-based identity.
            const row = await ctx.db.get("pullRequestThreads", linkId);

            await ctx.db.patch("pullRequestThreads", linkId, { watch: { ...row.watch, startedAt: STARTED_AT }, watchCheckedAt: LEASE });
        });

        const restarted = await rowOf(linkId);

        expect(restarted.watchRun).toBeTypeOf("string");
        expect(restarted.watchRun).not.toBe("run-1");

        await record(linkId, { ...stale, observation: observation({ headSha: "sha-stale" }) });
        await harness.run(async (ctx: any) => {
            await ctx.runMutation(recordWatchFailure, { ...stale, linkId, startedAt: STARTED_AT, status: "host_error" });
        });

        const after = await rowOf(linkId);

        expect(after.watch.baselined).toBeUndefined();
        expect(after.watchReadFailure).toBeUndefined();
        expect(await harness.run(async (ctx: any) => await ctx.runQuery(readWatchForPoll, { ...stale, linkId, startedAt: STARTED_AT }))).toBeNull();
    });
});

describe("a watch that can never be read", () => {
    const failTimes = async (linkId: string, times: number, status: string): Promise<void> => {
        for (let index = 0; index < times; index += 1) {
            await harness.run(async (ctx: any) => {
                await ctx.db.patch("pullRequestThreads", linkId, { watchCheckedAt: LEASE });
                await ctx.runMutation(recordWatchFailure, { lease: LEASE, linkId, startedAt: STARTED_AT, status });
            });
        }
    };

    it("ends after five terminal failures in a row, and not after four", async () => {
        const linkId = await seedWatch({ watch: { baselined: true, startedAt: STARTED_AT } });

        await failTimes(linkId, 4, "forbidden");

        const four = await rowOf(linkId);

        expect(four.watchActive).toBe(true);

        await failTimes(linkId, 1, "forbidden");

        const five = await rowOf(linkId);

        expect(five.watchActive).toBe(false);
        expect(five.watch.stoppedAt).toBeGreaterThan(0);
        expect(five.watchReadFailure).toMatchObject({ attempts: 5, status: "forbidden" });
    });

    it("keeps retrying a transient failure", async () => {
        const linkId = await seedWatch({ watch: { baselined: true, startedAt: STARTED_AT } });

        await failTimes(linkId, 7, "rate_limited");

        const row = await rowOf(linkId);

        expect(row.watchActive).toBe(true);
        expect(row.watch.stoppedAt).toBeUndefined();
    });
});

describe("a poll that runs twice", () => {
    it("records once: the repeat carries a consumed lease and its older observation is dropped", async () => {
        const linkId = await seedWatch({ watch: { baselined: true, headSha: "sha-0", reviewId: "r0", startedAt: STARTED_AT } });

        await record(linkId, { observation: observation({ headSha: "sha-new", reviews: [{ authorLogin: "bob", id: "r1" }] }) });
        await record(linkId, { observation: observation({ headSha: "sha-old", reviews: [] }) });

        const row = await rowOf(linkId);

        expect(row.watch).toMatchObject({ headSha: "sha-new", reviewId: "r1" });
        expect(row.watchCheckedAt).not.toBe(LEASE);
        expect(row.watchLeaseUntil).toBeGreaterThan(Date.now());
    });

    it("counts a failure once, and a restart counts its own from the first", async () => {
        const linkId = await seedWatch({ watch: { baselined: true, startedAt: STARTED_AT } });
        const { threadId: linkThread } = await rowOf(linkId);
        const threadId = String(linkThread);
        const fail = async () => {
            await harness.run(async (ctx: any) => {
                await ctx.runMutation(recordWatchFailure, { lease: LEASE, linkId, startedAt: STARTED_AT, status: "host_error" });
            });
        };

        await fail();
        await fail();

        const failed = await rowOf(linkId);

        expect(failed.watchReadFailure.attempts).toBe(1);

        await harness.run(async (ctx: any) => {
            for (const watching of [false, true]) {
                await ctx.runMutation(setPullRequestWatch, { number: 7, repository: "octo/hello", threadId, userId: OWNER, watching });
            }
        });

        const restarted = await rowOf(linkId);

        expect(restarted.watchReadFailure.attempts).toBe(0);

        await harness.run(async (ctx: any) => {
            await ctx.runMutation(recordWatchFailure, {
                lease: restarted.watchCheckedAt,
                linkId,
                run: restarted.watchRun,
                startedAt: restarted.watch.startedAt,
                status: "host_error",
            });
        });

        const again = await rowOf(linkId);

        expect(again.watchReadFailure.attempts).toBe(1);
    });
});

describe("recordWatchObservation", () => {
    it("ignores an answer whose lease is no longer the link's", async () => {
        const linkId = await seedWatch({ watchCheckedAt: LEASE + 1 });

        await record(linkId, { observation: observation({ state: "closed" }) });

        const row = await rowOf(linkId);

        expect(row.watchActive).toBe(true);
        expect(row.watch.stoppedAt).toBeUndefined();
        expect(row.watch.baselined).toBeUndefined();
    });

    it("ignores an answer for a watch that was restarted since it was leased", async () => {
        const linkId = await seedWatch({ watch: { startedAt: STARTED_AT + 50 } });

        await record(linkId, { observation: observation() });

        expect(await watchField(linkId, "watch.baselined")).toBeUndefined();
    });

    it("ignores an answer for a watch that was stopped meanwhile", async () => {
        const linkId = await seedWatch({ watch: { startedAt: STARTED_AT, stoppedAt: 2000 }, watchActive: false });

        await record(linkId, { observation: observation() });

        expect(await watchField(linkId, "watch.baselined")).toBeUndefined();
    });

    it("takes the baseline silently", async () => {
        const linkId = await seedWatch();

        await record(linkId, { observation: observation({ checks: "failing", headSha: "sha-9" }) });

        const row = await rowOf(linkId);

        expect(row.watch).toMatchObject({ baselined: true, checksHeadSha: "sha-9", headSha: "sha-9", startedAt: STARTED_AT });
        expect(row.watch.lastWakeAt).toBeUndefined();
        expect(row.watchPending).toEqual([]);
        expect(row.watchActive).toBe(true);
    });

    it("ends the watch and clears watchActive when the pull request is closed", async () => {
        const linkId = await seedWatch();

        for (const state of ["closed", "merged"] as const) {
            await harness.run(async (ctx: any) => {
                await ctx.db.patch("pullRequestThreads", linkId, { watch: { startedAt: STARTED_AT }, watchActive: true });
            });
            await record(linkId, { observation: observation({ state }) });

            const row = await rowOf(linkId);

            expect(row.watchActive).toBe(false);
            expect(row.watch.stoppedAt).toBeGreaterThan(0);
            expect(row.watch.startedAt).toBe(STARTED_AT);
        }
    });

    it("ends a watch that reached its wake cap", async () => {
        const linkId = await seedWatch({ watch: { baselined: true, headSha: "sha-1", startedAt: STARTED_AT, wakes: PR_WATCH_MAX_WAKES } });

        await record(linkId, { observation: observation() });

        const row = await rowOf(linkId);

        expect(row.watchActive).toBe(false);
        expect(row.watch.stoppedAt).toBeGreaterThan(0);
        expect(row.watch.wakes).toBe(PR_WATCH_MAX_WAKES);
    });

    it("records a wake's reasons and markers, and leaves the count and the cooldown as they were", async () => {
        const linkId = await seedWatch({ watch: { baselined: true, headSha: "sha-1", startedAt: STARTED_AT, wakes: 2 } });

        await record(linkId, { observation: observation({ checks: "failing", failingCheckNames: ["build"], reviews: [{ authorLogin: "bob", id: "r1" }] }) });

        const row = await rowOf(linkId);

        expect(row.watchPending).toEqual(["checks", "review"]);
        expect(row.watch).toMatchObject({ checksHeadSha: "sha-1", reviewId: "r1", wakes: 2 });
        expect(row.watch.lastWakeAt).toBeUndefined();
        expect(row.watchActive).toBe(true);
    });

    it("keeps the stored lastWakeAt on a wake", async () => {
        const lastWakeAt = Date.now() - PR_WATCH_WAKE_COOLDOWN_MS - 1000;
        const linkId = await seedWatch({ watch: { baselined: true, headSha: "sha-1", lastWakeAt, startedAt: STARTED_AT, wakes: 1 } });

        await record(linkId, { observation: observation({ mergeable: "conflicting" }) });

        const row = await rowOf(linkId);

        expect(row.watchPending).toEqual(["conflict"]);
        expect(row.watch).toMatchObject({ lastWakeAt, wakes: 1 });
    });

    it("does not end the watch on the cap however often an undelivered wake is read", async () => {
        const linkId = await seedWatch({ watch: { baselined: true, headSha: "sha-1", startedAt: STARTED_AT } });

        for (let read = 0; read < PR_WATCH_MAX_WAKES + 3; read += 1) {
            await harness.run(async (ctx: any) => {
                await ctx.db.patch("pullRequestThreads", linkId, { watchCheckedAt: LEASE });
            });
            await record(linkId, { observation: observation({ checks: "failing", headSha: "sha-1" }) });
        }

        const row = await rowOf(linkId);

        expect(row.watchActive).toBe(true);
        expect(row.watch.stoppedAt).toBeUndefined();
        expect(row.watch.wakes).toBeUndefined();
        expect(row.watchPending).toEqual(["checks"]);
    });

    it("keeps an occurrence seen during the cooldown as pending, without a wake", async () => {
        const lastWakeAt = Date.now() - PR_WATCH_WAKE_COOLDOWN_MS / 2;
        const linkId = await seedWatch({ watch: { baselined: true, headSha: "sha-1", lastWakeAt, startedAt: STARTED_AT, wakes: 1 } });

        await record(linkId, { observation: observation({ mergeable: "conflicting" }) });

        const row = await rowOf(linkId);

        expect(row.watchPending).toEqual(["conflict"]);
        expect(row.watch).toMatchObject({ conflictHeadSha: "sha-1", lastWakeAt, wakes: 1 });
    });

    it("stores what decideWatch says for the stored state", async () => {
        const previous = { baselined: true, checksHeadSha: "sha-0", headSha: "sha-0", reviewId: "r0", wakes: 2 };
        const linkId = await seedWatch({ watch: { ...previous, startedAt: STARTED_AT }, watchPending: [] });
        const observed = observation({
            headSha: "sha-2",
            mergeable: "unknown",
            reviews: [
                { authorLogin: "me", id: "r5" },
                { authorLogin: "bob", id: "r0" },
            ],
        });

        await record(linkId, { observation: observed });

        const row = await rowOf(linkId);
        const decision = decideWatch(stateOf({ watch: { ...previous, startedAt: STARTED_AT } }), observed, row.watch.lastWakeAt ?? Date.now());
        const expected = storedWatchOf({ ...decision.state, startedAt: STARTED_AT });

        expect(decision.action).toBe("none");
        expect(row.watch).toEqual(expected.watch);
        expect(row.watchPending).toEqual(expected.watchPending ?? []);
    });
});
