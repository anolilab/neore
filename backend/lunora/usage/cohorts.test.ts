import { describe, expect, it } from "vitest";

import { COHORT_SIZE, cohortOfBooking } from "./cohorts";

describe("cohortOfBooking", () => {
    it("places each run of COHORT_SIZE bookings in one cohort, in booking order", () => {
        const cohorts = Array.from({ length: COHORT_SIZE * 3 }, (_unused, booking) => cohortOfBooking(booking));

        expect(cohorts).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
    });

    it("never gives a later booking an earlier cohort", () => {
        for (let booking = 1; booking < 100; booking += 1) {
            expect(cohortOfBooking(booking)).toBeGreaterThanOrEqual(cohortOfBooking(booking - 1));
        }
    });
});
