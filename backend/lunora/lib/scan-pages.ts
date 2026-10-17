/**
 * Walks a paginated read until the visitor stops it or the rows run out, for
 * scans whose filter cannot be part of the index read.
 *
 * The page budget is the only bound: one query must not run forever, and 20
 * pages keeps a worst-case scan to a few thousand rows rather than a user's
 * whole history. A caller that hits it has looked at the newest
 * `maxPages * pageSize` rows and answers from those.
 *
 * Returns true when the budget ran out before the rows did, so the caller can say its answer
 * covers only the newest rows.
 */
export const SCAN_PAGE_BUDGET = 20;

export interface ScanPage<T> {
    continueCursor: string | null;
    isDone: boolean;
    page: T[];
}

/** `visit` returns true to stop the scan. */
export const scanPages = async <T>(
    fetchPage: (cursor: string | null) => Promise<ScanPage<T>>,
    visit: (item: T) => Promise<boolean> | boolean,
    maxPages: number = SCAN_PAGE_BUDGET,
): Promise<boolean> => {
    let cursor: string | null = null;

    for (let pages = 0; pages < maxPages; pages += 1) {
        const result: ScanPage<T> = await fetchPage(cursor);

        for (const item of result.page) {
            if (await visit(item)) {
                return false;
            }
        }

        if (result.isDone || !result.continueCursor) {
            return false;
        }

        cursor = result.continueCursor;
    }

    return true;
};
