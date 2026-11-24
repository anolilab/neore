/**
 * Cohort slots against the database: its unique key refuses a second claim of a slot, a member booked twice keeps one cohort, and a
 * contributor booked after the walk read a cohort does not change that cohort's members in the next read.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { isUniqueViolation } from "../lib/error-helpers";
import { allocateCohort, COHORT_SIZE, insertContributor } from "./cohorts";
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
            await ctx.db.insert("usageOrganizationCohortSlots", { claimedAt: 0, organizationId: "org-1", slot: 0 });

            try {
                await ctx.db.insert("usageOrganizationCohortSlots", { claimedAt: 0, organizationId: "org-1", slot: 0 });

                return false;
            } catch (error) {
                return isUniqueViolation(error);
            }
        });

        expect(refused).toBe(true);
    });

    it("keeps a member in one cohort when they are booked twice, and gives their second slot back", async () => {
        const entries = await harness.run(async (ctx: any) => {
            const member = { createdAt: 1, organizationId: "org-1", userId: "m0" };

            await insertContributor(ctx, member);
            await insertContributor(ctx, member);

            const contributors = await ctx.db.usageOrganizationContributors.findMany({ where: { organizationId: "org-1" } });
            const slots = await ctx.db.usageOrganizationCohortSlots.findMany({ where: { organizationId: "org-1" } });

            return { contributors: contributors.page, slots: slots.page };
        });

        expect(entries.contributors).toHaveLength(1);
        expect(entries.slots).toHaveLength(1);
    });

    it("does not book a guest again while a merge hands their entry to their new account", async () => {
        const entries = await harness.run(async (ctx: any) => {
            await ctx.db.insert("usageOrganizationContributors", { cohort: 0, createdAt: 1, mergedFrom: "guest", organizationId: "org-1", userId: "user" });
            // A reply the guest's shard records during the merge: its reconcile books the guest.
            await insertContributor(ctx, { createdAt: 2, organizationId: "org-1", userId: "guest" });
            // The guest's own entry, marked to go once their shard is empty (the new account outranks it in `org-2`).
            await ctx.db.insert("usageOrganizationContributors", { cohort: 0, createdAt: 1, mergedFrom: "guest", organizationId: "org-2", userId: "guest" });
            await insertContributor(ctx, { createdAt: 2, organizationId: "org-2", userId: "guest" });

            const contributors = await ctx.db.usageOrganizationContributors.findMany({ where: { mergedFrom: "guest" } });
            const slots = await ctx.db.usageOrganizationCohortSlots.findMany({});

            return {
                contributors: contributors.page
                    .map((row: any) => `${row.organizationId}:${row.userId}` as string)
                    .toSorted((a: string, b: string) => a.localeCompare(b)),
                slots: slots.page.length,
            };
        });

        expect(entries).toStrictEqual({ contributors: ["org-1:user", "org-2:guest"], slots: 0 });
    });

    it("does not seal a cohort whose duplicate booking failed after another member claimed the next slot", async () => {
        const scope = await harness.run(async (ctx: any) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "admin", userId: ADMIN });

            for (const userId of ["m0", "m1", "m2"]) {
                await insertContributor(ctx, { createdAt: 1, organizationId: "org-1", userId });
            }

            // A second booking of m0 claims slot 3; before its contributor row is refused, m3 is booked and claims slot 4.
            let raced = false;
            const db = new Proxy(ctx.db, {
                get: (target, property) => {
                    if (property === "insert") {
                        return async (table: string, row: { userId?: string }) => {
                            if (table === "usageOrganizationContributors" && row.userId === "m0" && !raced) {
                                raced = true;
                                await insertContributor(ctx, { createdAt: 2, organizationId: "org-1", userId: "m3" });
                            }

                            return await target.insert(table, row);
                        };
                    }

                    const value = Reflect.get(target, property);

                    return typeof value === "function" ? value.bind(target) : value;
                },
            });
            const racing = Object.create(ctx, { db: { value: db } });

            await insertContributor(racing, { createdAt: 2, organizationId: "org-1", userId: "m0" });

            const { page } = await ctx.db.usageOrganizationCohortSlots.findMany({ where: { organizationId: "org-1" } });

            return {
                scope: await ctx.runQuery(organizationUsageScope, { organizationId: "org-1", slotsSettledBefore: Number.MAX_SAFE_INTEGER, userId: ADMIN }),
                slots: page.map((row: any) => row.slot as number).toSorted((a: number, b: number) => a - b),
            };
        });

        // Slot 3 was given back after slot 4 was taken: the top slot ends cohort 0, but it holds four members and is not sealed.
        expect(scope.slots).toEqual([0, 1, 2, 4]);
        expect(scope.scope.members.map((member: { userId: string }) => member.userId)).toEqual(["m0", "m1", "m2", "m3"]);
        expect(scope.scope.sealedCohorts).toEqual([]);
    });

    it("seals a cohort once each of its slots was filled", async () => {
        const scope = await harness.run(async (ctx: any) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-1", role: "admin", userId: ADMIN });

            for (let index = 0; index < COHORT_SIZE; index += 1) {
                await insertContributor(ctx, { createdAt: index, organizationId: "org-1", userId: `m${String(index)}` });
            }

            return await ctx.runQuery(organizationUsageScope, { organizationId: "org-1", slotsSettledBefore: Number.MAX_SAFE_INTEGER, userId: ADMIN });
        });

        expect(scope.sealedCohorts).toEqual([0]);
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
