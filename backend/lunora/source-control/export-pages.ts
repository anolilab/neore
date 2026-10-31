/** One page of `collectReviewDraftsForExport`: the drafts, and where the next page starts (`null` when this was the last). */
interface ReviewDraftsPage {
    cursor?: string | null;
    drafts?: unknown[];
}

/**
 * Walks every page of a user's review drafts for the export workflow. `readPage` runs one page as
 * its own workflow step (given the cursor and the page number, for the step's name). A result without a cursor
 * ends the walk, which is also how a step recorded before paging existed replays.
 */
export const collectAllReviewDrafts = async (readPage: (cursor: string | null, page: number) => Promise<unknown>): Promise<{ drafts: unknown[] }> => {
    const drafts: unknown[] = [];
    let cursor: string | null = null;

    for (let page = 0; ; page += 1) {
        const result = (await readPage(cursor, page)) as ReviewDraftsPage;

        drafts.push(...(result.drafts ?? []));

        if (!result.cursor) {
            return { drafts };
        }

        cursor = result.cursor;
    }
};

/** One page of `collectGuidesForExport`: same contract as the drafts' page. */
interface GuidesPage {
    cursor?: string | null;
    guides?: unknown[];
}

/** Walks every page of a user's guides for the export workflow, one workflow step per page (a guide can be large). */
export const collectAllGuides = async (readPage: (cursor: string | null, page: number) => Promise<unknown>): Promise<{ guides: unknown[] }> => {
    const guides: unknown[] = [];
    let cursor: string | null = null;

    for (let page = 0; ; page += 1) {
        const result = (await readPage(cursor, page)) as GuidesPage;

        guides.push(...(result.guides ?? []));

        if (!result.cursor) {
            return { guides };
        }

        cursor = result.cursor;
    }
};
