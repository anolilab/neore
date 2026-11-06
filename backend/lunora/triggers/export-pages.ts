/** One page of `collectTriggersForExport`: its triggers, and where the next page starts (`null` when this was the last). */
interface TriggersPage {
    cursor?: string | null;
    triggers?: unknown[];
}

/**
 * Collects every page of a user's triggers, running each page as a query inside the export action (`generateExportFile`).
 * A result without a cursor ends the walk.
 */
export const collectAllTriggers = async (readPage: (cursor: string | null) => Promise<unknown>): Promise<{ triggers: unknown[] }> => {
    const triggers: unknown[] = [];
    let cursor: string | null = null;

    for (;;) {
        const result = (await readPage(cursor)) as TriggersPage;

        triggers.push(...(result.triggers ?? []));

        if (!result.cursor) {
            return { triggers };
        }

        cursor = result.cursor;
    }
};
