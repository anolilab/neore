/**
 * The organization ledger against the in-memory harness: a reply filed under an organization's project is recorded with the organization
 * it belonged to, so a project moved in later does not show its earlier usage, and erasure removes the member's rows.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { recordReplyUsage } from "./activity";
import { DEFAULT_SKILL_KEY } from "./activity-logic";
import { eraseUsageForUser, pruneOrganizationRepliesBefore } from "./gdpr";
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

/** The member's organization totals for `projectIds` from `since` on. */
const orgUsage = async (organizationId: string, projectIds: string[], since: number) => {
    const result = (await harness.run(
        async (ctx: any) => await ctx.runQuery(memberProjectUsage, { organizationId, projectIds, projectsListed: true, since, userId: MEMBER }),
    )) as {
        active: boolean;
        projects: { costMicrodollars: number; projectKey: string; replies: number; tokens: number }[];
        removed?: { costMicrodollars: number; replies: number; tokens: number };
        truncated: boolean;
    };

    // The sums and the removed total; `active` is checked where it is asked for.
    return { projects: result.projects, ...(result.removed && { removed: result.removed }), truncated: result.truncated };
};

beforeEach(() => {
    // The scheduled contributor reconcile (`reconcileOrganizationContributor`) runs on `harness.scheduler.runPending()`, by its name.
    harness = lunoraTest(schema as never, { functions: { "usage_organization:reconcileOrganizationContributor": reconcileOrganizationContributor } } as never);
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

        expect(await orgUsage("org-1", [project], 0)).toEqual({
            projects: [{ costMicrodollars: 100, projectKey: project, replies: 1, tokens: 10 }],
            truncated: false,
        });
        expect(await orgUsage("org-1", [project], 2000)).toEqual({ projects: [], truncated: false });
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

        expect(await orgUsage("org-1", [project], 0)).toEqual({ projects: [], truncated: false });

        // A reply made after the move is filed under the organization.
        await record(project, 2000);

        expect(await orgUsage("org-1", [project], 0)).toEqual({
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

        expect(await orgUsage("org-1", [], 0)).toEqual({
            projects: [],
            removed: { costMicrodollars: 100, replies: 1, tokens: 10 },
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

        expect(await orgUsage("org-1", [project], 0)).toEqual({ projects: [], truncated: false });
    });

    it("does not call a project removed when the organization's project list was cut off", async () => {
        const project = await harness.run(async (ctx: any) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "member", userId: MEMBER });

            return await ctx.db.insert("projects", { createdAt: 1, organizationId: "org-1", title: "Team", userId: OWNER });
        });

        await record(project, 1000);

        // The project is still the organization's, but past the cap of listed projects: it is not known to have left.
        const cut = await harness.run(
            async (ctx: any) =>
                await ctx.runQuery(memberProjectUsage, { organizationId: "org-1", projectIds: [], projectsListed: false, since: 0, userId: MEMBER }),
        );

        expect(cut).toEqual({ active: true, projects: [], truncated: false });
    });

    it("reports whether a member had replies in the period, for the quiet-page rule", async () => {
        const project = await harness.run(async (ctx: any) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "member", userId: MEMBER });

            return await ctx.db.insert("projects", { createdAt: 1, organizationId: "org-1", title: "Team", userId: OWNER });
        });

        await record(project, 1000);
        const activeSince = async (since: number) =>
            (await harness.run(
                async (ctx: any) =>
                    await ctx.runQuery(memberProjectUsage, { organizationId: "org-1", projectIds: [project], projectsListed: true, since, userId: MEMBER }),
            )) as { active: boolean };

        const sinceZero = await activeSince(0);
        const sinceLater = await activeSince(2000);

        expect(sinceZero.active).toBe(true);
        expect(sinceLater.active).toBe(false);
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
        expect(await orgUsage("org-1", [project], 0)).toEqual({ projects: [], truncated: false });
        expect(scope?.members.map((entry: { userId: string }) => entry.userId)).not.toContain(MEMBER);
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

        expect(await orgUsage("org-1", [project], 0)).toEqual({ projects: [], truncated: false });
    });
});
