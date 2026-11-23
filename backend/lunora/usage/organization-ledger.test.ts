/**
 * The organization ledger against the in-memory harness: a reply filed under an organization's project is recorded with the organization
 * it belonged to, so a project moved in later does not show its earlier usage, and erasure removes the member's rows.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { recordReplyUsage } from "./activity";
import { DEFAULT_SKILL_KEY, ORGANIZATION_RECORD_LATE_MS } from "./activity-logic";
import { eraseUsageForUser, MAX_PRUNED_ORGANIZATIONS, pruneOrganizationRepliesBefore } from "./gdpr";
import {
    collectOrganizationRepliesForExport,
    collectOrganizationReplyPages,
    memberProjectUsage,
    organizationUsageScope,
    reconcileOrganizationContributor,
} from "./organization";

const ADMIN = "admin-1";
const MEMBER = "member-1";
const OWNER = "owner-1";

const NOW = 10_000;

let harness: ReturnType<typeof lunoraTest>;
let replies = 0;

/**
 * Files one reply under `projectKey`, as the live path does when the thread's project is known. The contributor entry is booked after the
 * reply commits, so the scheduled work runs here, as the live scheduler would run it.
 */
const record = async (projectKey: string, at: number, costMicrodollars = 100): Promise<void> => {
    replies += 1;

    await harness.run(
        async (ctx: any) =>
            await ctx.runMutation(recordReplyUsage, {
                at,
                costMicrodollars,
                date: "2026-09-20",
                replyKey: `reply-${String(replies)}`,
                skillKey: DEFAULT_SKILL_KEY,
                threadAttribution: { projectKey },
                tokens: 10,
                userId: MEMBER,
            }),
    );
    await harness.scheduler.runPending();
};

/** The member's organization rows from `since` on, summed per project. */
const orgUsage = async (organizationId: string, since: number) => {
    const result = (await harness.run(
        async (ctx: any) => await ctx.runQuery(memberProjectUsage, { from: since, organizationId, until: Number.MAX_SAFE_INTEGER, userId: MEMBER }),
    )) as { cells: { costMicrodollars: number; projectKey: string; replies: number; tokens: number }[]; truncated: boolean };
    const projects = new Map<string, { costMicrodollars: number; projectKey: string; replies: number; tokens: number }>();

    for (const cell of result.cells) {
        const sum = projects.get(cell.projectKey) ?? { costMicrodollars: 0, projectKey: cell.projectKey, replies: 0, tokens: 0 };

        sum.costMicrodollars += cell.costMicrodollars;
        sum.replies += cell.replies;
        sum.tokens += cell.tokens;
        projects.set(cell.projectKey, sum);
    }

    return { projects: [...projects.values()], truncated: result.truncated };
};

beforeEach(() => {
    // The scheduled contributor reconcile (`reconcileOrganizationContributor`) runs on `harness.scheduler.runPending()`, by its name.
    // The clock is just after the replies the tests record: an organization row is written only close to its reply.
    harness = lunoraTest(
        schema as never,
        { functions: { "usage_organization:reconcileOrganizationContributor": reconcileOrganizationContributor }, now: NOW } as never,
    );
    replies = 0;
});

afterEach(() => {
    harness.close();
});

describe("the organization ledger", () => {
    it("files a reply under the organization's project, and the view sums it from the reply's instant", async () => {
        const project = await harness.run(async (ctx: any) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "member", userId: MEMBER });

            return await ctx.db.insert("projects", { createdAt: 1, organizationId: "org-1", title: "Team", userId: OWNER });
        });

        await record(project, 1000);

        expect(await orgUsage("org-1", 0)).toEqual({
            projects: [{ costMicrodollars: 100, projectKey: project, replies: 1, tokens: 10 }],
            truncated: false,
        });
        expect(await orgUsage("org-1", 2000)).toEqual({ projects: [], truncated: false });
    });

    it("does not show a reply made before its project moved into the organization", async () => {
        const project = await harness.run(async (ctx: any) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "member", userId: MEMBER });

            return await ctx.db.insert("projects", { createdAt: 1, title: "Mine", userId: MEMBER });
        });

        // A personal project: the reply is filed under the user's own usage only, not the organization's.
        await record(project, 1000);
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("projects", project, { organizationId: "org-1" });
        });

        expect(await orgUsage("org-1", 0)).toEqual({ projects: [], truncated: false });

        // A reply made after the move is filed under the organization.
        await record(project, 2000);

        expect(await orgUsage("org-1", 0)).toEqual({
            projects: [{ costMicrodollars: 100, projectKey: project, replies: 1, tokens: 10 }],
            truncated: false,
        });
    });

    it("keeps the replies of a project that left the organization, as one total with no project named", async () => {
        const project = await harness.run(async (ctx: any) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "member", userId: MEMBER });

            return await ctx.db.insert("projects", { createdAt: 1, organizationId: "org-1", title: "Team", userId: OWNER });
        });

        await record(project, 1000);
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("projects", project, { organizationId: "org-2" });
        });

        // The row keeps its project; the walk adds it to the removed total, unnamed (`releaseCells`).
        expect(await orgUsage("org-1", 0)).toEqual({
            projects: [{ costMicrodollars: 100, projectKey: project, replies: 1, tokens: 10 }],
            truncated: false,
        });
    });

    it("does not file a reply counted without its project under the organization the project has when it is filed late", async () => {
        const project = await harness.run(async (ctx: any) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "member", userId: MEMBER });

            return await ctx.db.insert("projects", { createdAt: 1, organizationId: "org-1", title: "Team", userId: OWNER });
        });
        const reply = {
            at: 1000,
            costMicrodollars: 100,
            date: "2026-09-20",
            replyKey: "late-1",
            skillKey: DEFAULT_SKILL_KEY,
            threadAttribution: { projectKey: project },
            tokens: 10,
            userId: MEMBER,
        };

        // Counted without its project: the project's read failed when the reply was made.
        await harness.run(async (ctx: any) => await ctx.runMutation(recordReplyUsage, { ...reply, projectUnread: true }));
        // Filed on the retry, with the project read then.
        await harness.run(async (ctx: any) => await ctx.runMutation(recordReplyUsage, { ...reply, retry: true }));
        await harness.scheduler.runPending();

        expect(await orgUsage("org-1", 0)).toEqual({ projects: [], truncated: false });
    });

    it("reads only the period's days, so a member's reply outside it is not in the walk's cells", async () => {
        const project = await harness.run(async (ctx: any) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "member", userId: MEMBER });

            return await ctx.db.insert("projects", { createdAt: 1, organizationId: "org-1", title: "Team", userId: OWNER });
        });

        await record(project, 1000);
        const cellsBetween = async (from: number, until: number) =>
            (
                (await harness.run(async (ctx: any) => await ctx.runQuery(memberProjectUsage, { from, organizationId: "org-1", until, userId: MEMBER }))) as {
                    cells: unknown[];
                }
            ).cells;

        expect(await cellsBetween(0, 2000)).toHaveLength(1);
        expect(await cellsBetween(2000, 3000)).toEqual([]);
        expect(await cellsBetween(0, 1000)).toEqual([]);
    });

    it("writes no organization row for a reply recorded long after it was made, since its day may already be shown", async () => {
        const project = await harness.run(async (ctx: any) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "member", userId: MEMBER });

            return await ctx.db.insert("projects", { createdAt: 1, organizationId: "org-1", title: "Team", userId: OWNER });
        });

        await record(project, NOW - ORGANIZATION_RECORD_LATE_MS - 1);
        await record(project, NOW - ORGANIZATION_RECORD_LATE_MS);

        expect(await orgUsage("org-1", -Number.MAX_SAFE_INTEGER)).toEqual({
            projects: [{ costMicrodollars: 100, projectKey: project, replies: 1, tokens: 10 }],
            truncated: false,
        });
    });

    it("still lists a member who has left, so their usage keeps counting", async () => {
        const project = await harness.run(async (ctx: any) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "admin", userId: ADMIN });
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "member", userId: MEMBER });

            return await ctx.db.insert("projects", { createdAt: 1, organizationId: "org-1", title: "Team", userId: OWNER });
        });

        await record(project, 1000);
        await harness.run(async (ctx: any) => {
            const { page } = await ctx.db.member.findMany({ where: { organizationId: "org-1", userId: MEMBER } });

            await ctx.db.delete("member", page[0]._id);
        });

        const scope = (await harness.run(async (ctx: any) => await ctx.runQuery(organizationUsageScope, { organizationId: "org-1", userId: ADMIN }))) as {
            members: { cohort: number; userId: string }[];
        } | null;

        expect(scope?.members.map((entry: { userId: string }) => entry.userId)).toContain(MEMBER);
    });

    it("lists a member once, even when two entries exist for them", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "admin", userId: ADMIN });
            await ctx.db.insert("usageOrganizationContributors", { cohort: 0, createdAt: 1, organizationId: "org-1", userId: MEMBER });
            await ctx.db.insert("usageOrganizationContributors", { cohort: 0, createdAt: 2, organizationId: "org-1", userId: MEMBER });
        });

        const scope = (await harness.run(async (ctx: any) => await ctx.runQuery(organizationUsageScope, { organizationId: "org-1", userId: ADMIN }))) as {
            members: { cohort: number; userId: string }[];
        } | null;

        expect(scope?.members.map((entry: { userId: string }) => entry.userId)).toEqual([MEMBER]);
    });

    it("collects every page of the ledger for the export in reply-time order, and past its budget keeps the newest rows and says it cut the oldest", async () => {
        // Newest first, as the export reads it: the first page holds the newest rows.
        const read = async (cursor: string | null) =>
            cursor === null ? { cursor: "next", rows: [{ at: 3 }, { at: 2 }] } : { cursor: null, rows: [{ at: 1 }] };

        expect(await collectOrganizationReplyPages(read, 1000)).toEqual({ cut: false, rows: [{ at: 1 }, { at: 2 }, { at: 3 }] });
        // Each row is eight bytes; with the brackets and a comma after the first kept row, two fit in twenty, and the oldest is cut for a third.
        expect(await collectOrganizationReplyPages(read, 20)).toEqual({ cut: true, rows: [{ at: 2 }, { at: 3 }] });
    });

    it("reads the member's ledger newest first, so the export can stop at its budget", async () => {
        const project = await harness.run(async (ctx: any) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "member", userId: MEMBER });

            return await ctx.db.insert("projects", { createdAt: 1, organizationId: "org-1", title: "Team", userId: OWNER });
        });

        await record(project, 1000);
        await record(project, 3000);
        await record(project, 2000);

        const page = (await harness.run(async (ctx: any) => await ctx.runQuery(collectOrganizationRepliesForExport, { cursor: null, userId: MEMBER }))) as {
            rows: { at: number }[];
        };

        expect(page.rows.map((row) => row.at)).toEqual([3000, 2000, 1000]);
    });

    it("stops reading after its page cap and says it cut what it did not read, keeping the newest rows it read", async () => {
        const reads: (string | null)[] = [];
        const read = async (cursor: string | null) => {
            reads.push(cursor);

            return cursor === null ? { cursor: "next", rows: [{ at: 9 }, { at: 8 }] } : { cursor: "more", rows: [{ at: 7 }] };
        };

        expect(await collectOrganizationReplyPages(read, 1000, 1)).toEqual({ cut: true, rows: [{ at: 8 }, { at: 9 }] });
        expect(reads).toEqual([null]);
    });

    it("prunes rows past the retention window, and a contributor left with none drops off the list", async () => {
        const project = await harness.run(async (ctx: any) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "admin", userId: ADMIN });
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "member", userId: MEMBER });

            return await ctx.db.insert("projects", { createdAt: 1, organizationId: "org-1", title: "Team", userId: OWNER });
        });

        await record(project, 1000);
        const pruned = await harness.run(async (ctx: any) => await pruneOrganizationRepliesBefore(ctx, 2000, 100));

        await harness.scheduler.runPending();
        const scope = (await harness.run(async (ctx: any) => await ctx.runQuery(organizationUsageScope, { organizationId: "org-1", userId: ADMIN }))) as {
            members: { cohort: number; userId: string }[];
        } | null;

        expect(pruned).toBe(1);
        expect(await orgUsage("org-1", 0)).toEqual({ projects: [], truncated: false });
        expect(scope?.members.map((entry: { userId: string }) => entry.userId)).not.toContain(MEMBER);
    });

    it("prunes the rows of a bounded number of organizations per batch, and books a reconcile only for one left with no rows", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < MAX_PRUNED_ORGANIZATIONS + 10; index += 1) {
                await ctx.db.insert("usageOrganizationReplies", {
                    at: 1000 + index,
                    costMicrodollars: 1,
                    organizationId: `org-${String(index)}`,
                    projectKey: "project",
                    replyKey: `reply-${String(index)}`,
                    tokens: 1,
                    userId: MEMBER,
                });
            }

            // A newer row keeps org-0's ledger, so it needs no reconcile.
            await ctx.db.insert("usageOrganizationReplies", {
                at: 5000,
                costMicrodollars: 1,
                organizationId: "org-0",
                projectKey: "project",
                replyKey: "reply-kept",
                tokens: 1,
                userId: MEMBER,
            });
        });

        const pruned = await harness.run(async (ctx: any) => await pruneOrganizationRepliesBefore(ctx, 2000, 200));
        const left = await harness.run(async (ctx: any) => await ctx.db.usageOrganizationReplies.findMany({ where: { at: { lt: 2000 } } }));

        expect(pruned).toBe(MAX_PRUNED_ORGANIZATIONS);
        expect(left.page).toHaveLength(10);
        expect(harness.scheduler.list()).toHaveLength(MAX_PRUNED_ORGANIZATIONS - 1);
    });

    it("removes every contributor entry of a member left with no rows, not only the first", async () => {
        const project = await harness.run(async (ctx: any) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "admin", userId: ADMIN });
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "member", userId: MEMBER });

            return await ctx.db.insert("projects", { createdAt: 1, organizationId: "org-1", title: "Team", userId: OWNER });
        });

        await record(project, 1000);
        // A second entry, as two first replies recorded at once would leave.
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("usageOrganizationContributors", { cohort: 0, createdAt: 2, organizationId: "org-1", userId: MEMBER });
        });
        await harness.run(async (ctx: any) => await pruneOrganizationRepliesBefore(ctx, 2000, 100));
        await harness.scheduler.runPending();

        const entries = await harness.run(
            async (ctx: any) => await ctx.db.usageOrganizationContributors.findMany({ where: { organizationId: "org-1", userId: MEMBER } }),
        );

        expect(entries.page).toEqual([]);
    });

    it("books a member's contributor entry once they have rows, drops a ghost one with none, and running it again changes nothing", async () => {
        const project = await harness.run(async (ctx: any) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "member", userId: MEMBER });

            return await ctx.db.insert("projects", { createdAt: 1, organizationId: "org-1", title: "Team", userId: OWNER });
        });
        const entriesOf = async (): Promise<unknown[]> => {
            const result = (await harness.run(
                async (ctx: any) => await ctx.db.usageOrganizationContributors.findMany({ where: { organizationId: "org-1", userId: MEMBER } }),
            )) as { page: unknown[] };

            return result.page;
        };
        const reconcile = async () =>
            await harness.run(async (ctx: any) => await ctx.runMutation(reconcileOrganizationContributor, { organizationId: "org-1", userId: MEMBER }));

        // An entry with no rows under it, as a reply whose mutation aborted would leave.
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("usageOrganizationContributors", { cohort: 0, createdAt: 2, organizationId: "org-1", userId: MEMBER });
        });
        await reconcile();

        expect(await entriesOf()).toEqual([]);

        await record(project, 1000);

        expect(await entriesOf()).toHaveLength(1);

        await reconcile();

        expect(await entriesOf()).toHaveLength(1);
    });

    it("keeps one contributor entry for a member with rows, when two were booked at once", async () => {
        const project = await harness.run(async (ctx: any) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "member", userId: MEMBER });

            return await ctx.db.insert("projects", { createdAt: 1, organizationId: "org-1", title: "Team", userId: OWNER });
        });

        await record(project, 1000);
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("usageOrganizationContributors", { cohort: 0, createdAt: 2, organizationId: "org-1", userId: MEMBER });
        });
        await harness.run(async (ctx: any) => await ctx.runMutation(reconcileOrganizationContributor, { organizationId: "org-1", userId: MEMBER }));

        const entries = await harness.run(
            async (ctx: any) => await ctx.db.usageOrganizationContributors.findMany({ where: { organizationId: "org-1", userId: MEMBER } }),
        );

        expect(entries.page).toHaveLength(1);
    });

    it("removes a member's rows when their account is erased", async () => {
        const project = await harness.run(async (ctx: any) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "member", userId: MEMBER });

            return await ctx.db.insert("projects", { createdAt: 1, organizationId: "org-1", title: "Team", userId: OWNER });
        });

        await record(project, 1000);
        await harness.run(async (ctx: any) => await eraseUsageForUser(ctx, MEMBER));

        expect(await orgUsage("org-1", 0)).toEqual({ projects: [], truncated: false });
    });
});
