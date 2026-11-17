/**
 * The organization usage walk: its groups are stable cohorts, a group is withheld when some but not all of its members were active, and a
 * cursor opens only for the organization the server issued it for. Without these a caller could pick the groups, swap members by moving the
 * period start or by booking a newcomer, and read one member's usage.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { cohortOfBooking } from "./cohorts";
import {
    CURSOR_TTL_MS,
    groupByCohort,
    groupReleased,
    MIN_MEMBERS_PER_GROUP,
    openOrganizationCursor,
    organizationUsageScope,
    pageWithheld,
    sealOrganizationCursor,
    withoutLastCohort,
} from "./organization";

const ADMIN = "admin-1";

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

/** Adds `count` contributors under `org-1`, booked in order into their cohorts, and an admin of it. */
const seedContributors = async (count: number): Promise<void> => {
    await harness.run(async (ctx: any) => {
        await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "admin", userId: ADMIN });

        for (let index = 0; index < count; index += 1) {
            await ctx.db.insert("usageOrganizationContributors", {
                cohort: cohortOfBooking(index),
                createdAt: index,
                organizationId: "org-1",
                userId: `m${String(index).padStart(2, "0")}`,
            });
        }
    });
};

/** The walk's contributor batch after `after`, read as an admin. */
const scopeBatch = async (after?: { cohort: number; userId: string }) =>
    (await harness.run(
        async (ctx: any) =>
            await ctx.runQuery(organizationUsageScope, {
                organizationId: "org-1",
                userId: ADMIN,
                ...(after !== undefined && { afterCohort: after.cohort, afterUserId: after.userId }),
            }),
    )) as { members: { cohort: number; userId: string }[]; more: boolean } | null;

const member = (active: boolean, cohort: number, index: number) => {
    return { active, cohort, index };
};

const indexesOf = (groups: { index: number }[][]) => groups.map((group) => group.map((entry) => entry.index));

describe("groupByCohort", () => {
    it("makes one group per cohort, whole, in walk order", () => {
        const members = [member(true, 0, 0), member(false, 0, 1), member(true, 1, 2), member(false, 2, 3), member(false, 2, 4)];

        expect(indexesOf(groupByCohort(members))).toEqual([[0, 1], [2], [3, 4]]);
    });

    it("forms the same groups whatever the period made active, so a period start cannot swap a cohort's members", () => {
        const cohorts = Array.from({ length: MIN_MEMBERS_PER_GROUP * 3 }, (_, index) => cohortOfBooking(index));
        const allQuiet = cohorts.map((cohort, index) => member(false, cohort, index));
        const allActive = cohorts.map((cohort, index) => member(true, cohort, index));

        expect(indexesOf(groupByCohort(allQuiet))).toEqual(indexesOf(groupByCohort(allActive)));
    });

    it("does not move the members of an earlier cohort when a later cohort books more contributors", () => {
        const before = Array.from({ length: MIN_MEMBERS_PER_GROUP * 2 }, (_, index) => member(true, cohortOfBooking(index), index));
        const later = [...before, ...Array.from({ length: 3 }, (_, index) => member(true, cohortOfBooking(10 + index), 10 + index))];

        expect(indexesOf(groupByCohort(later)).slice(0, 2)).toEqual(indexesOf(groupByCohort(before)));
    });
});

describe("withoutLastCohort", () => {
    it("drops the cohort the walk stopped inside, which is the last one walked", () => {
        const walked = Array.from({ length: MIN_MEMBERS_PER_GROUP + 3 }, (_, index) => member(true, cohortOfBooking(index), index));

        expect(withoutLastCohort(walked).map((entry) => entry.index)).toEqual([0, 1, 2, 3, 4]);
    });

    it("keeps the whole walk when it stopped inside its only cohort, so the walk still moves on", () => {
        const walked = [member(true, 0, 0), member(true, 0, 1)];

        expect(withoutLastCohort(walked)).toHaveLength(2);
        expect(withoutLastCohort([])).toEqual([]);
    });
});

describe("groupReleased", () => {
    it("withholds a group whose member read past the ledger's ceiling, so no response says which member it was", () => {
        const group = Array.from({ length: MIN_MEMBERS_PER_GROUP }, (_, index) => {
            return { active: true, truncated: index === 2 };
        });

        expect(groupReleased(group)).toBe(false);
        expect(
            groupReleased(
                group.map((entry) => {
                    return { ...entry, truncated: false };
                }),
            ),
        ).toBe(true);
    });
});

describe("pageWithheld", () => {
    const members = (active: number, total: number) =>
        Array.from({ length: total }, (_, index) => {
            return { active: index < active };
        });

    it("withholds a group where a few members were active and the rest quiet", () => {
        expect(pageWithheld(members(1, 5))).toBe(true);
        expect(pageWithheld(members(MIN_MEMBERS_PER_GROUP - 1, 25))).toBe(true);
    });

    it("withholds a cohort short of its members (a booking race, or an entry removed) when any of them was active", () => {
        expect(pageWithheld(members(4, 4))).toBe(true);
        expect(pageWithheld(members(1, 2))).toBe(true);
    });

    it("shows a group with enough active members, or with none (it shows nothing to hide)", () => {
        expect(pageWithheld(members(MIN_MEMBERS_PER_GROUP, 25))).toBe(false);
        expect(pageWithheld(members(0, 25))).toBe(false);
        expect(pageWithheld(members(0, 3))).toBe(false);
        expect(pageWithheld([])).toBe(false);
    });
});

describe("the organization's contributors, a batch at a time", () => {
    it("walks the cohorts in order, a batch of ten, and says when more contributors follow", async () => {
        await seedContributors(25);

        const first = await scopeBatch();

        expect(first?.members).toHaveLength(10);
        expect(first?.more).toBe(true);

        const second = await scopeBatch(first?.members.at(-1));

        expect(second?.members).toHaveLength(10);
        expect(second?.more).toBe(true);

        const last = await scopeBatch(second?.members.at(-1));

        expect(last?.members).toHaveLength(5);
        expect(last?.more).toBe(false);
    });

    it("covers a short organization in one batch, with nothing more", async () => {
        await seedContributors(5);

        const page = await scopeBatch();

        expect(page?.members).toHaveLength(5);
        expect(page?.more).toBe(false);
    });
});

describe("the sealed cursor", () => {
    const ISSUED = 1_000_000;
    const SINCE = 500;
    const POSITION = { cohort: 1, userId: "m07" };

    it("opens for the organization and period it was sealed for, and only those", async () => {
        const sealed = await sealOrganizationCursor("org-1", POSITION, SINCE, ISSUED);

        expect(await openOrganizationCursor("org-1", SINCE, sealed, ISSUED)).toEqual(POSITION);
        await expect(openOrganizationCursor("org-2", SINCE, sealed, ISSUED)).rejects.toThrow("not valid");
        await expect(openOrganizationCursor("org-1", SINCE + 1, sealed, ISSUED)).rejects.toThrow("not valid");
    });

    it("expires an hour after it was issued", async () => {
        const sealed = await sealOrganizationCursor("org-1", POSITION, SINCE, ISSUED);

        expect(await openOrganizationCursor("org-1", SINCE, sealed, ISSUED + CURSOR_TTL_MS)).toEqual(POSITION);
        await expect(openOrganizationCursor("org-1", SINCE, sealed, ISSUED + CURSOR_TTL_MS + 1)).rejects.toThrow("not valid");
    });

    it("refuses a cursor the server did not issue", async () => {
        await expect(openOrganizationCursor("org-1", SINCE, "m07", ISSUED)).rejects.toThrow("not valid");
        await expect(openOrganizationCursor("org-1", SINCE, "", ISSUED)).rejects.toThrow("not valid");
    });
});
