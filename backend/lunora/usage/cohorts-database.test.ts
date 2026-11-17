/**
 * Cohort slots against the database: its unique key refuses a second claim of a slot, and a contributor booked after the walk read a cohort
 * does not change that cohort's members in the next read.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { isUniqueViolation } from "../lib/error-helpers";
import { allocateCohort, COHORT_SIZE } from "./cohorts";
import { organizationUsageScope } from "./organization";

const ADMIN = "admin-1";

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

/** The walk's first batch as an admin of `org-1`: the members in cohort order. */
const firstBatch = async () =>
    (await harness.run(async (ctx: any) => await ctx.runQuery(organizationUsageScope, { organizationId: "org-1", userId: ADMIN }))) as {
        members: { cohort: number; userId: string }[];
        more: boolean;
    } | null;

describe("cohort slots in the database", () => {
    it("refuses a second claim of a slot the database already holds", async () => {
        const refused = await harness.run(async (ctx: any) => {
            await ctx.db.insert("usageOrganizationCohortSlots", { organizationId: "org-1", slot: 0 });

            try {
                await ctx.db.insert("usageOrganizationCohortSlots", { organizationId: "org-1", slot: 0 });

                return false;
            } catch (error) {
                return isUniqueViolation(error);
            }
        });

        expect(refused).toBe(true);
    });

    it("keeps a released cohort's members when a contributor is booked after the first read", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "admin", userId: ADMIN });

            for (let index = 0; index < COHORT_SIZE; index += 1) {
                const cohort = await allocateCohort(ctx, "org-1");

                await ctx.db.insert("usageOrganizationContributors", { cohort, createdAt: index, organizationId: "org-1", userId: `m${index}` });
            }
        });

        const before = await firstBatch();

        await harness.run(async (ctx: any) => {
            const cohort = await allocateCohort(ctx, "org-1");

            await ctx.db.insert("usageOrganizationContributors", { cohort, createdAt: 99, organizationId: "org-1", userId: "late" });
        });

        const after = await firstBatch();

        expect(before?.members.map((member) => member.userId)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
        expect(after?.members.slice(0, COHORT_SIZE)).toEqual(before?.members);
        expect(after?.members.at(-1)).toEqual({ cohort: 1, userId: "late" });
    });
});
