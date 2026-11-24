/** One page of `collectChatFilesForExport`: the files, and where the next page starts (`null` when this was the last). */
interface ChatFilesPage {
    cursor?: string | null;
    files?: unknown[];
}

/**
 * Walks every page of the user's chat files for the export workflow. `readPage` runs one page as its own workflow step (given the
 * cursor and the page number, for the step's name). A result without a cursor ends the walk.
 *
 * Kept apart from `gdpr.ts`: the export workflow imports this, and `gdpr.ts` pulls in the job queue, which the mobile and extension
 * type checks do not resolve.
 */
export const collectAllChatFiles = async (readPage: (cursor: string | null, page: number) => Promise<unknown>): Promise<unknown[]> => {
    const files: unknown[] = [];
    let cursor: string | null = null;

    for (let page = 0; ; page += 1) {
        const result = (await readPage(cursor, page)) as ChatFilesPage;

        files.push(...(result.files ?? []));

        if (!result.cursor) {
            return files;
        }

        cursor = result.cursor;
    }
};
