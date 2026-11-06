/** One page of `collectTriggersForExport`: its triggers, and where the next page starts (`null` when this was the last). */
interface TriggersPage {
    cursor?: string | null;
    triggers?: unknown[];
}

/**
 * Walks every page of a user's triggers for the export workflow. `readPage` runs one page as its own workflow step
 * (given the cursor and the page number, for the step's name). A result without a cursor ends the walk, which is also
 * how a step recorded before paging existed replays.
 */
export const collectAllTriggers = async (readPage: (cursor: string | null, page: number) => Promise<unknown>): Promise<{ triggers: unknown[] }> => {
    const triggers: unknown[] = [];
    let cursor: string | null = null;

    for (let page = 0; ; page += 1) {
        const result = (await readPage(cursor, page)) as TriggersPage;

        triggers.push(...(result.triggers ?? []));

        if (!result.cursor) {
            return { triggers };
        }

        cursor = result.cursor;
    }
};
