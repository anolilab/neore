/**
 * The watch poller's records (`pr-watch-poll.ts`): the sweep leases only due running watches, and an observation is
 * recorded exactly as `decideWatch` says, only while its lease and its watch are still current.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { insertThread } from "../agent/table-writes";
import { runInShard } from "../lib/shard-context";
import schema from "../schema";
import { PR_WATCH_POLL_INTERVAL_MS, dispatchDueWatches, recordWatchObservation } from "./pr-watch-poll";
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

const record = async (linkId: string, args: { lease?: number; observation: PullRequestObservation; startedAt?: number }): Promise<void> => {
    await harness.run(async (ctx: any) => {
        await ctx.runMutation(recordWatchObservation, { lease: LEASE, linkId, startedAt: STARTED_AT, ...args });
    });
};

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

    it("takes a bounded number of watches per sweep", async () => {
        for (let number = 1; number <= 12; number += 1) {
            await seedWatch({ watchCheckedAt: undefined }, number);
        }

        const result = await harness.run(async (ctx: any) => await runInShard(OWNER, () => ctx.runMutation(dispatchDueWatches, {})));

        expect(result.dispatched).toBe(10);
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
