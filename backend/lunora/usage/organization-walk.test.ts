/**
 * The organization usage walk: its groups are fixed by member order, a group is withheld when some but not all of its members were active,
 * and a cursor opens only for the organization the server issued it for. Without these a caller could pick the groups, swap members by
 * moving the period start, and read one member's usage.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import {
    CURSOR_TTL_MS,
    groupMembers,
    groupReleased,
    MIN_MEMBERS_PER_GROUP,
    openOrganizationCursor,
    organizationUsageScope,
    pageWithheld,
    sealOrganizationCursor,
} from "./organization";

const ADMIN = "admin-1";

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

/** Adds `count` members with rows under `org-1`, and an admin of it. */
const seedContributors = async (count: number): Promise<void> => {
    await harness.run(async (ctx: any) => {
        await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "admin", userId: ADMIN });

        for (let index = 0; index < count; index += 1) {
            await ctx.db.insert("usageOrganizationContributors", { createdAt: index, organizationId: "org-1", userId: `m${String(index).padStart(2, "0")}` });
        }
    });
};

/** The walk's contributor batch after `afterUserId`, read as an admin. */
const scopeBatch = async (afterUserId?: string) =>
    (await harness.run(
        async (ctx: any) =>
            await ctx.runQuery(organizationUsageScope, { organizationId: "org-1", userId: ADMIN, ...(afterUserId !== undefined && { afterUserId }) }),
    )) as { memberIds: string[]; more: boolean } | null;

const member = (active: boolean, index: number) => {
    return { active, index };
};

describe("groupMembers", () => {
    it("splits the members into fixed groups of the minimum, in walk order, and leaves the trailing members open", () => {
        const members = Array.from({ length: MIN_MEMBERS_PER_GROUP * 2 + 2 }, (_, index) => member(index % 2 === 0, index));
        const { closed, open } = groupMembers(members);

        expect(closed.map((group) => group.map((entry) => entry.index))).toEqual([
            [0, 1, 2, 3, 4],
            [5, 6, 7, 8, 9],
        ]);
        expect(open.map((entry) => entry.index)).toEqual([10, 11]);
    });

    it("forms the same groups whatever the period made active, so a period start cannot swap a group's members", () => {
        const allQuiet = Array.from({ length: MIN_MEMBERS_PER_GROUP * 3 }, (_, index) => member(false, index));
        const allActive = allQuiet.map((entry) => member(true, entry.index));

        expect(groupMembers(allQuiet).closed.map((group) => group.map((entry) => entry.index))).toEqual(
            groupMembers(allActive).closed.map((group) => group.map((entry) => entry.index)),
        );
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

    it("withholds an open group where a few members were active and the rest quiet", () => {
        expect(pageWithheld(members(1, 5))).toBe(true);
        expect(pageWithheld(members(MIN_MEMBERS_PER_GROUP - 1, 25))).toBe(true);
    });

    it("shows an open group with enough active members, or with none (it shows nothing to hide)", () => {
        expect(pageWithheld(members(MIN_MEMBERS_PER_GROUP, 25))).toBe(false);
        expect(pageWithheld(members(0, 25))).toBe(false);
        expect(pageWithheld([])).toBe(false);
    });
});

describe("the organization's contributors, a batch at a time", () => {
    it("returns a batch of ten, and says when more contributors follow", async () => {
        await seedContributors(25);

        const first = await scopeBatch();

        expect(first?.memberIds).toHaveLength(10);
        expect(first?.more).toBe(true);

        const second = await scopeBatch(first?.memberIds.at(-1));

        expect(second?.memberIds).toHaveLength(10);
        expect(second?.more).toBe(true);

        const last = await scopeBatch(second?.memberIds.at(-1));

        expect(last?.memberIds).toHaveLength(5);
        expect(last?.more).toBe(false);
    });

    it("covers a short organization in one batch, with nothing more", async () => {
        await seedContributors(5);

        const page = await scopeBatch();

        expect(page?.memberIds).toHaveLength(5);
        expect(page?.more).toBe(false);
    });
});

describe("the sealed cursor", () => {
    const ISSUED = 1_000_000;
    const SINCE = 500;

    it("opens for the organization and period it was sealed for, and only those", async () => {
        const sealed = await sealOrganizationCursor("org-1", "m07", SINCE, ISSUED);

        expect(await openOrganizationCursor("org-1", SINCE, sealed, ISSUED)).toBe("m07");
        await expect(openOrganizationCursor("org-2", SINCE, sealed, ISSUED)).rejects.toThrow("not valid");
        await expect(openOrganizationCursor("org-1", SINCE + 1, sealed, ISSUED)).rejects.toThrow("not valid");
    });

    it("expires an hour after it was issued", async () => {
        const sealed = await sealOrganizationCursor("org-1", "m07", SINCE, ISSUED);

        expect(await openOrganizationCursor("org-1", SINCE, sealed, ISSUED + CURSOR_TTL_MS)).toBe("m07");
        await expect(openOrganizationCursor("org-1", SINCE, sealed, ISSUED + CURSOR_TTL_MS + 1)).rejects.toThrow("not valid");
    });

    it("refuses a cursor the server did not issue", async () => {
        await expect(openOrganizationCursor("org-1", SINCE, "m07", ISSUED)).rejects.toThrow("not valid");
        await expect(openOrganizationCursor("org-1", SINCE, "", ISSUED)).rejects.toThrow("not valid");
    });
});
