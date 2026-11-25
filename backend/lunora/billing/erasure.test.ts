/**
 * How one erasure run walks a reference's rows. The page bound is what stops a run from spinning; the completion flag is
 * what tells the caller whether another run must follow. A run that finds nothing on a page is complete, and a run that
 * stops at the bound with rows still to go is not, so its caller continues it.
 */
import { describe, expect, it, vi } from "vitest";

import { deleteAllBillingRows } from "./gdpr";

/** `count` copies of `value`. */
const repeated = (value: boolean, count: number): boolean[] => {
    const values: boolean[] = [];

    for (let index = 0; index < count; index += 1) {
        values.push(value);
    }

    return values;
};

/** A page source that reports `hasMore` for each call in `sequence`, then keeps reporting no more rows. */
const pages = (sequence: boolean[]) => {
    let call = 0;

    return vi.fn(async () => {
        const hasMore = sequence[call] ?? false;

        call += 1;

        return { hasMore };
    });
};

describe("deleteAllBillingRows", () => {
    it("reports complete after one page when that page leaves nothing behind", async () => {
        expect.assertions(2);

        const deletePage = pages([false]);

        await expect(deleteAllBillingRows(deletePage)).resolves.toBe(true);
        expect(deletePage).toHaveBeenCalledTimes(1);
    });

    it("reports a run that fills its last page as incomplete, and the continuation that finds nothing as complete", async () => {
        expect.assertions(3);

        // Exactly 100,000 rows: all 500 pages are full, so the run cannot tell that the rows are gone.
        const first = pages(repeated(true, 500));

        await expect(deleteAllBillingRows(first)).resolves.toBe(false);

        // The continuation finds the reference empty and completes without another throw.
        const continuation = pages([false]);

        await expect(deleteAllBillingRows(continuation)).resolves.toBe(true);
        expect(continuation).toHaveBeenCalledTimes(1);
    });

    it("stops at the page bound with rows still to go, and reports incomplete without throwing", async () => {
        expect.assertions(2);

        const deletePage = pages(repeated(true, 1000));

        await expect(deleteAllBillingRows(deletePage)).resolves.toBe(false);
        expect(deletePage).toHaveBeenCalledTimes(500);
    });
});
