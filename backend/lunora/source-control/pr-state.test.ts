/**
 * The housekeeping sweep that keeps a linked pull request's stored state fresh (`pr-state.ts`). Only open links whose
 * state is stale are leased, nothing is leased unless auto-archive is on and the person keeps open-pull-request chats,
 * and a host answer lands only for the check that leased it.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { autoArchiveCutoff } from "../agent/auto-archive-logic";
import { internal } from "../_generated/internal";
import { runInShard } from "../lib/shard-context";
import schema from "../schema";
import { PR_STATE_MAX_AGE_MS, dispatchLinkedPullRequestChecks, recordLinkState, scheduleArchiveAfterClose } from "./pr-state";

type Harness = ReturnType<typeof lunoraTest>;

const OWNER = "user-owner";
const NOW_LINK = { createdAt: 0, kind: "attached", title: "Add the thing", url: "https://example.test/acme/app/pull/7" } as const;

/** Auto-archive on (30 days) and the keep setting absent (on): the state is read and kept fresh. */
const ON = { days: 30 as number | undefined, keep: undefined as boolean | undefined };

let harness: Harness;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

interface LinkSeed {
    state?: "open" | "closed" | "merged";
    stateCheckedAt?: number;
    /** The chat was active just now, so auto-archive would not consider it idle. */
    threadActive?: boolean;
    /** The chat is archived already. */
    threadArchived?: boolean;
    threadDeleted?: boolean;
}

/** Inserts one thread and link per seed and the user's settings, then runs `sweeps` sweeps as the owner's shard. */
const seedAndSweep = (links: LinkSeed[], settings: typeof ON, sweeps = 1) =>
    harness.run(async (ctx: any) => {
        await ctx.db.insert("userSettings", {
            userId: OWNER,
            ...(settings.days !== undefined && { autoArchiveAfterDays: settings.days }),
            ...(settings.keep !== undefined && { keepOpenPullRequestChats: settings.keep }),
        });

        const linkIds: string[] = [];

        for (const [index, link] of links.entries()) {
            const threadId = await ctx.db.insert("threads", {
                mode: "text",
                model: "gpt-4o",
                status: link.threadArchived === true ? "archived" : "active",
                title: `Thread ${index}`,
                updatedAt: link.threadActive === true ? Date.now() : 1,
                userId: OWNER,
            });

            linkIds.push(
                await ctx.db.insert("pullRequestThreads", {
                    ...NOW_LINK,
                    number: index + 1,
                    repository: "acme/app",
                    threadId,
                    userId: OWNER,
                    ...(link.state !== undefined && { state: link.state }),
                    ...(link.stateCheckedAt !== undefined && { stateCheckedAt: link.stateCheckedAt }),
                    ...(link.threadDeleted !== undefined && { threadDeleted: link.threadDeleted }),
                }),
            );
        }

        const dispatched: number[] = [];

        for (let sweep = 0; sweep < sweeps; sweep += 1) {
            const result = await runInShard(OWNER, () => ctx.runMutation(dispatchLinkedPullRequestChecks, {}));

            dispatched.push(result.dispatched);
        }

        const stamped = await Promise.all(linkIds.map((id) => ctx.db.get("pullRequestThreads", id)));

        return { dispatched, stamped: stamped.map((row: any) => row?.stateCheckedAt) };
    });

describe("dispatchLinkedPullRequestChecks", () => {
    it("leases an open link whose state was never read, and stamps it", async () => {
        const { dispatched, stamped } = await seedAndSweep([{}], ON);

        expect(dispatched).toEqual([1]);
        expect(stamped[0]).toBeTypeOf("number");
    });

    it("leases nothing while the person keeps open-pull-request chats off", async () => {
        const { dispatched, stamped } = await seedAndSweep([{}], { days: 30, keep: false });

        expect(dispatched).toEqual([0]);
        expect(stamped[0]).toBeUndefined();
    });

    it("leases nothing while auto-archive is off, since nothing reads the state then", async () => {
        const { dispatched } = await seedAndSweep([{}], { days: undefined, keep: true });

        expect(dispatched).toEqual([0]);
    });

    it("skips a link whose state is closed or merged", async () => {
        const { dispatched } = await seedAndSweep([{ state: "closed" }, { state: "merged" }], ON);

        expect(dispatched).toEqual([0]);
    });

    it("skips a link whose state was read recently, and leases one read long ago", async () => {
        const recent = Date.now() - 1000;
        const old = Date.now() - PR_STATE_MAX_AGE_MS - 1000;
        const { dispatched } = await seedAndSweep(
            [
                { state: "open", stateCheckedAt: recent },
                { state: "open", stateCheckedAt: old },
            ],
            ON,
        );

        expect(dispatched).toEqual([1]);
    });

    it("leases nothing for a link whose chat is still active, since auto-archive would not consider it idle", async () => {
        const { dispatched } = await seedAndSweep([{ threadActive: true }], ON);

        expect(dispatched).toEqual([0]);
    });

    it("leases nothing for a link whose chat is already archived", async () => {
        const { dispatched } = await seedAndSweep([{ threadArchived: true }], ON);

        expect(dispatched).toEqual([0]);
    });

    it("reaches an idle chat's link behind more than 80 links on archived chats, within two sweeps", async () => {
        const archived = Array.from({ length: 85 }, () => {
            return { threadArchived: true };
        });
        const { dispatched } = await seedAndSweep([...archived, {}], ON, 2);

        // Sweep one looks up 80 archived chats and skips them; sweep two reaches the idle chat's link.
        expect(dispatched).toEqual([0, 1]);
    });

    it("skips a link whose thread is deleted", async () => {
        const { dispatched } = await seedAndSweep([{ threadDeleted: true }], ON);

        expect(dispatched).toEqual([0]);
    });

    it("reaches every open link across sweeps, so the first 20 do not starve the rest", async () => {
        const links = Array.from({ length: 25 }, () => {
            return {};
        });
        const { dispatched, stamped } = await seedAndSweep(links, ON, 2);

        // The first sweep leases 20; the second finds the other 5 unread and leases them.
        expect(dispatched).toEqual([20, 5]);
        expect(stamped.every((checkedAt) => typeof checkedAt === "number")).toBe(true);
    });

    it("reaches an open link past the first page of 500, since the scan resumes on the next page", async () => {
        const closed = Array.from({ length: 500 }, (): LinkSeed => {
            return { state: "closed" };
        });
        const { dispatched } = await seedAndSweep([...closed, {}], ON, 2);

        // Sweep one reads the 500 closed links, finds nothing stale and moves on; sweep two reads the page holding the open link.
        expect(dispatched).toEqual([0, 1]);
    });
});

describe("scheduleArchiveAfterClose", () => {
    const NOW = 1_000_000_000_000;

    /** Runs the scheduling against the harness's own database, with a scheduler the test can read. */
    const scheduleFor = (days: number | undefined) =>
        harness.run(async (ctx: any) => {
            if (days !== undefined) {
                await ctx.db.insert("userSettings", { autoArchiveAfterDays: days, userId: OWNER });
            }

            const threadId = await ctx.db.insert("threads", { mode: "text", model: "gpt-4o", status: "active", title: "Thread", updatedAt: 1, userId: OWNER });
            const runAfter = vi.fn(async () => "job");

            await scheduleArchiveAfterClose({ db: ctx.db, now: NOW, scheduler: { runAfter } as never }, { threadId, userId: OWNER });

            return { runAfter, threadId };
        });

    it("schedules the chat's archive check at once, as of now, when its link is recorded closed", async () => {
        const { runAfter, threadId } = await scheduleFor(30);

        expect(runAfter).toHaveBeenCalledWith(0, internal.agent.auto_archive.archiveIfStillIdle, { cutoff: autoArchiveCutoff(NOW, 30), threadId });
    });

    it("schedules nothing when auto-archive is off, since nothing archives then", async () => {
        const { runAfter } = await scheduleFor(undefined);

        expect(runAfter).not.toHaveBeenCalled();
    });
});

describe("recordLinkState", () => {
    it("writes the state the host gave when the lease is the link's current check", async () => {
        const state = await harness.run(async (ctx: any) => {
            const threadId = await ctx.db.insert("threads", { mode: "text", model: "gpt-4o", status: "active", title: "Thread", updatedAt: 1, userId: OWNER });
            const linkId = await ctx.db.insert("pullRequestThreads", {
                ...NOW_LINK,
                number: 9,
                repository: "acme/app",
                stateCheckedAt: 500,
                threadId,
                userId: OWNER,
            });

            await ctx.runMutation(recordLinkState, { lease: 500, linkId, state: "merged" });

            return await ctx.db.get("pullRequestThreads", linkId);
        });

        expect(state.state).toBe("merged");
        expect(state.stateCheckedAt).toBeTypeOf("number");
    });

    it("drops a late answer from an older check, so it cannot overwrite a newer open state", async () => {
        const state = await harness.run(async (ctx: any) => {
            const threadId = await ctx.db.insert("threads", { mode: "text", model: "gpt-4o", status: "active", title: "Thread", updatedAt: 1, userId: OWNER });
            const linkId = await ctx.db.insert("pullRequestThreads", {
                ...NOW_LINK,
                number: 9,
                repository: "acme/app",
                state: "open",
                stateCheckedAt: 900,
                threadId,
                userId: OWNER,
            });

            // The check leased at 400 finishes after the check leased at 900 was recorded.
            await ctx.runMutation(recordLinkState, { lease: 400, linkId, state: "closed" });

            return await ctx.db.get("pullRequestThreads", linkId);
        });

        expect(state.state).toBe("open");
        expect(state.stateCheckedAt).toBe(900);
    });
});
