/**
 * The organization view across period starts: a total released for one start and one released for another differ by whole cohort-weeks,
 * never by one member's spend. The finding's scenario: the first cohort used a project before a cutoff, the second after, and one member of
 * the first is the only difference between the two periods.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { cohortOfBooking } from "./cohorts";
import { getOrganizationProjectUsage } from "./organization";

const { harnessRef, registry } = vi.hoisted(() => {
    return {
        harnessRef: { current: undefined as unknown as { run: (body: (ctx: any) => Promise<unknown>) => Promise<unknown> } },
        registry: new Map<string, unknown>(),
    };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    const sessionFrom = async (context: { auth: { userId?: string | null } }) =>
        context.auth.userId ? { activeOrganization: { id: "org-1" }, id: context.auth.userId, userId: context.auth.userId } : null;

    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/rate-limiter")>()), rateLimitGuard: async () => undefined };
});

// The harness is one database for every shard: a member's shard is read in place.
vi.mock("../lib/cross-shard", () => {
    return { callOnShard: async (reference: never, args: never) => await harnessRef.current.run(async (ctx) => await ctx.runQuery(reference, args)) };
});

const ADMIN = "admin-1";
const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
/** The Monday 00:00 UTC that starts week `week` (the epoch began on a Thursday). */
const weekStart = (week: number): number => week * WEEK + 4 * DAY;
// Wednesday noon of week 100: weeks 97 to 99 have closed, week 100 is open.
const NOW = weekStart(100) + 2 * DAY + 12 * 60 * 60 * 1000;

let harness: ReturnType<typeof lunoraTest>;

beforeAll(async () => {
    registerModule(registry, "usage_organization", await import("./organization"));
});

beforeEach(() => {
    harness = lunoraTest(schema as never, { now: NOW } as never);
    harnessRef.current = harness as never;
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});

afterEach(() => {
    vi.useRealTimers();
    harness.close();
});

/**
 * Ten contributors in two cohorts, each with one reply a week under `org-1`, on the week's Thursday: `projectOf(member, week)` names its
 * project. With `slots`, the cohorts' booking slots are taken too, so both cohorts are sealed.
 */
const seed = async (projectOf: (member: number, week: number) => string, weeks: number[], { slots = false } = {}): Promise<void> => {
    await harness.run(async (ctx: any) => {
        await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "admin", userId: ADMIN });
        await ctx.db.insert("projects", { createdAt: 1, organizationId: "org-1", title: "Team", userId: ADMIN });

        for (let member = 0; member < 10; member += 1) {
            const userId = `m${String(member)}`;

            await ctx.db.insert("usageOrganizationContributors", { cohort: cohortOfBooking(member), createdAt: member, organizationId: "org-1", userId });

            if (slots) {
                await ctx.db.insert("usageOrganizationCohortSlots", { claimedAt: 0, organizationId: "org-1", slot: member });
            }

            for (const week of weeks) {
                await ctx.db.insert("usageOrganizationReplies", {
                    at: weekStart(week) + 3 * DAY + 60_000,
                    // Each member's spend is distinct, so a difference equal to one member's spend is recognisable.
                    costMicrodollars: 1000 + member,
                    organizationId: "org-1",
                    projectKey: projectOf(member, week),
                    replyKey: `${userId}-${String(week)}`,
                    tokens: 10,
                    userId,
                });
            }
        }
    });
};

const projectId = async (): Promise<string> =>
    (await harness.run(async (ctx: any) => {
        const { page } = await ctx.db.projects.findMany({ where: { organizationId: "org-1" } });

        return page[0]._id as string;
    })) as string;

const usageSince = async (since: number) =>
    (await harness.withIdentity({ userId: ADMIN } as never).action(getOrganizationProjectUsage as never, { organizationId: "org-1", since } as never)) as {
        projects: { costMicrodollars: number; projectKey: string }[];
        small?: { costMicrodollars: number };
        truncated: boolean;
    };

const spendOf = (result: Awaited<ReturnType<typeof usageSince>>, projectKey: string): number =>
    result.projects.find((project) => project.projectKey === projectKey)?.costMicrodollars ?? 0;

/** Files the rows seeded under "TEAM" under the organization's project, and returns its id. */
const fileTeam = async (): Promise<string> => {
    const team = await projectId();

    await harness.run(async (ctx: any) => {
        const { page } = await ctx.db.usageOrganizationReplies.findMany({ where: { projectKey: "TEAM" } });

        for (const row of page) {
            await ctx.db.patch("usageOrganizationReplies", row._id, { projectKey: team });
        }
    });

    return team;
};

const spendOfMembers = (members: number[]): number => members.reduce((sum, member) => sum + 1000 + member, 0);

describe("the organization view across period starts", () => {
    it("never releases two totals that differ by one member's spend when the cutoff moves past that member's last reply", async () => {
        // Week 98: member 0 is the only one on the team project; everyone else is active elsewhere. Week 99: member 0 is elsewhere and the
        // other nine are on the team project. Moving the start from week 98 to 99 drops member 0's one team reply and nothing else of it.
        await seed((member, week) => ((week === 98) === (member === 0) ? "TEAM" : "side"), [98, 99]);
        const team = await fileTeam();

        const before = await usageSince(weekStart(98));
        const after = await usageSince(weekStart(99));
        const difference = spendOf(before, team) - spendOf(after, team);

        // Member 0's week-98 team reply was never in a released team total: in its cohort's week it is folded with the others' projects.
        expect(spendOf(after, team)).toBeGreaterThan(0);
        expect(difference).not.toBe(1000);
        expect(difference).toBe(0);
    });

    it("releases a closed week once: a period start inside the week, or a read days later, changes no released total; the open week is left out", async () => {
        await seed(() => "TEAM", [99, 100]);

        const team = await fileTeam();
        const weekStarted = await usageSince(weekStart(99));
        const midWeek = await usageSince(weekStart(99) + 4 * DAY);

        vi.setSystemTime(NOW + 3 * DAY);

        const later = await usageSince(weekStart(99));

        expect(spendOf(midWeek, team)).toBe(spendOf(weekStarted, team));
        expect(spendOf(later, team)).toBe(spendOf(weekStarted, team));
        // Week 99 only: week 100 is still open, so its replies are not in any total yet.
        expect(spendOf(weekStarted, team)).toBe(spendOfMembers(Array.from({ length: 10 }, (_, member) => member)));
    });

    it("shows a sealed cohort that lost a member with the members it has, and withholds it while its last slot is still settling", async () => {
        await seed(() => "TEAM", [99], { slots: true });

        const team = await fileTeam();

        // Member 3 leaves the first cohort: their rows and contributor entry are gone; their booking slot stays taken.
        await harness.run(async (ctx: any) => {
            for (const table of ["usageOrganizationReplies", "usageOrganizationContributors"]) {
                const { page } = await ctx.db[table].findMany({ where: { userId: "m3" } });

                for (const row of page) {
                    await ctx.db.delete(table, row._id);
                }
            }
        });

        const shown = await usageSince(weekStart(99));

        // The second cohort names the project with its five; the first, now four, shows in the folded total and names nothing.
        expect(spendOf(shown, team)).toBe(spendOfMembers([5, 6, 7, 8, 9]));
        expect(shown.small?.costMicrodollars).toBe(spendOfMembers([0, 1, 2, 4]));
        expect(shown.truncated).toBe(false);

        // The first cohort's last slot, and the later ones, claimed just now (slots are claimed in order): the slot's member may not be
        // readable yet, so the first cohort counts as still filling and is withheld until the slot settles.
        await harness.run(async (ctx: any) => {
            const { page } = await ctx.db.usageOrganizationCohortSlots.findMany({ where: { organizationId: "org-1" } });

            for (const row of page) {
                if (row.slot >= 4) {
                    await ctx.db.patch("usageOrganizationCohortSlots", row._id, { claimedAt: NOW });
                }
            }
        });

        const filling = await usageSince(weekStart(99));

        expect(filling.small).toBeUndefined();
        expect(filling.truncated).toBe(true);
    });
});
