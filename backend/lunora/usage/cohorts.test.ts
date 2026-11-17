import type { MutationCtx } from "../_generated/server";
import { describe, expect, it } from "vitest";

import { allocateCohort, COHORT_SIZE, cohortOfBooking } from "./cohorts";

type Slot = { organizationId: string; slot: number };

/**
 * A store with the database's unique key on (organization, slot). `live` is what inserts check; `snapshot` is what a booking reads first, so
 * two bookings that read before either inserts see the same top slot, as they would when they race.
 */
const racingCtx = (live: Slot[], snapshot: Slot[]): MutationCtx => {
    let reads = 0;

    return {
        db: {
            insert: async (_table: string, row: Slot) => {
                if (live.some((existing) => existing.organizationId === row.organizationId && existing.slot === row.slot)) {
                    throw { kind: "unique" };
                }

                live.push(row);
            },
            usageOrganizationCohortSlots: {
                findFirst: async ({ where }: { where: { organizationId: string } }) => {
                    // The first read is the stale one; a booking that lost the slot reads the live rows.
                    reads += 1;

                    const rows = (reads === 1 ? snapshot : live)
                        .filter((row) => row.organizationId === where.organizationId)
                        .toSorted((a, b) => b.slot - a.slot);

                    return rows[0] ?? null;
                },
            },
        },
    } as unknown as MutationCtx;
};

describe("cohortOfBooking", () => {
    it("places each run of COHORT_SIZE bookings in one cohort, in booking order", () => {
        const cohorts = Array.from({ length: COHORT_SIZE * 3 }, (_unused, slot) => cohortOfBooking(slot));

        expect(cohorts).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
    });

    it("never gives a later booking an earlier cohort", () => {
        for (let slot = 1; slot < 100; slot += 1) {
            expect(cohortOfBooking(slot)).toBeGreaterThanOrEqual(cohortOfBooking(slot - 1));
        }
    });
});

describe("allocateCohort", () => {
    it("claims the slot after the top one, so bookings in turn fill the cohorts in order", async () => {
        const live: Slot[] = [];

        const cohorts: number[] = [];

        for (let booking = 0; booking < COHORT_SIZE + 2; booking += 1) {
            cohorts.push(await allocateCohort(racingCtx(live, [...live]), "org-1"));
        }

        expect(cohorts).toEqual([0, 0, 0, 0, 0, 1, 1]);
    });

    it("gives two bookings that read the same top slot different slots, and the loser takes the next one", async () => {
        const live: Slot[] = [{ organizationId: "org-1", slot: 3 }];
        const snapshot = [...live];

        const [first, second] = await Promise.all([allocateCohort(racingCtx(live, snapshot), "org-1"), allocateCohort(racingCtx(live, snapshot), "org-1")]);

        expect(live.map((row) => row.slot).toSorted((a, b) => a - b)).toEqual([3, 4, 5]);
        expect([first, second].toSorted((a, b) => a - b)).toEqual([0, 1]);
    });

    it("keeps every cohort at COHORT_SIZE members or fewer when several book at once", async () => {
        const live: Slot[] = [];
        const snapshot: Slot[] = [];

        const cohorts = await Promise.all(Array.from({ length: 7 }, async () => await allocateCohort(racingCtx(live, snapshot), "org-1")));

        const sizes = new Map<number, number>();

        for (const cohort of cohorts) {
            sizes.set(cohort, (sizes.get(cohort) ?? 0) + 1);
        }

        expect(live.map((row) => row.slot).toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
        expect(Math.max(...sizes.values())).toBeLessThanOrEqual(COHORT_SIZE);
        expect(sizes.get(0)).toBe(COHORT_SIZE);
    });

    it("does not count another organization's slots", async () => {
        const live: Slot[] = [{ organizationId: "org-2", slot: 0 }];

        expect(await allocateCohort(racingCtx(live, [...live]), "org-1")).toBe(0);
    });
});
