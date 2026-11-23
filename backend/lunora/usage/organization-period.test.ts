/**
 * The organization view across period starts: a total released for one start and one released for another differ by whole cohort-days,
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
// Day 100 at noon: days 97 to 99 have closed.
const NOW = 100 * DAY + 12 * 60 * 60 * 1000;

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

/** Ten contributors in two cohorts, each with one reply a day under `org-1`: `projectOf(member, day)` names its project. */
const seed = async (projectOf: (member: number, day: number) => string, days: number[]): Promise<void> => {
    await harness.run(async (ctx: any) => {
        await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "admin", userId: ADMIN });
        await ctx.db.insert("projects", { createdAt: 1, organizationId: "org-1", title: "Team", userId: ADMIN });

        for (let member = 0; member < 10; member += 1) {
            const userId = `m${String(member)}`;

            await ctx.db.insert("usageOrganizationContributors", { cohort: cohortOfBooking(member), createdAt: member, organizationId: "org-1", userId });

            for (const day of days) {
                await ctx.db.insert("usageOrganizationReplies", {
                    at: day * DAY + 60_000,
                    // Each member's spend is distinct, so a difference equal to one member's spend is recognisable.
                    costMicrodollars: 1000 + member,
                    organizationId: "org-1",
                    projectKey: projectOf(member, day),
                    replyKey: `${userId}-${String(day)}`,
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

describe("the organization view across period starts", () => {
    it("never releases two totals that differ by one member's spend when the cutoff moves past that member's last reply", async () => {
        // Day 98: member 0 is the only one on the team project; everyone else is active elsewhere. Day 99: member 0 is elsewhere and the
        // other nine are on the team project. Moving the start from day 98 to 99 drops member 0's one team reply and nothing else of it.
        await seed((member, day) => ((day === 98) === (member === 0) ? "TEAM" : "side"), [98, 99]);
        const team = await projectId();

        await harness.run(async (ctx: any) => {
            const { page } = await ctx.db.usageOrganizationReplies.findMany({ where: { projectKey: "TEAM" } });

            for (const row of page) {
                await ctx.db.patch("usageOrganizationReplies", row._id, { projectKey: team });
            }
        });

        const before = await usageSince(98 * DAY);
        const after = await usageSince(99 * DAY);
        const difference = spendOf(before, team) - spendOf(after, team);

        // Member 0's day-98 team reply was never in a released team total: in its cohort's day it is folded with the others' projects.
        expect(spendOf(after, team)).toBeGreaterThan(0);
        expect(difference).not.toBe(1000);
        expect(difference).toBe(0);
    });

    it("releases a closed day once: a reply recorded later, or a period start inside the day, changes no released total", async () => {
        await seed(() => "TEAM", [99]);

        const team = await projectId();

        await harness.run(async (ctx: any) => {
            const { page } = await ctx.db.usageOrganizationReplies.findMany({ where: { projectKey: "TEAM" } });

            for (const row of page) {
                await ctx.db.patch("usageOrganizationReplies", row._id, { projectKey: team });
            }
        });

        const dayStart = await usageSince(99 * DAY);
        const midDay = await usageSince(99 * DAY + 60_001);

        expect(spendOf(midDay, team)).toBe(spendOf(dayStart, team));
        expect(spendOf(dayStart, team)).toBe(Array.from({ length: 10 }, (_, member) => 1000 + member).reduce((a, b) => a + b));
    });
});
