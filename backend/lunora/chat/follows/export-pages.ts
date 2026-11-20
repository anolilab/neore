/**
 * The account export's reader for `threadFollows` (`gdpr/steps.ts#generateExportFile`).
 */

type ThreadFollowExportPage = { continueCursor?: string; follows: unknown[]; readBytes: number };

/**
 * Every page of the user's follow rows, read through `readPage` until the last one or `maxBytes` read (its share of the
 * action's read budget, `gdpr/read-budget.ts#threadFollowsReadBudget`). Past it the section is marked as cut, never
 * dropped silently; with no budget left nothing is read. A page may run over it.
 */
export const collectAllThreadFollows = async (
    readPage: (cursor: string | undefined) => Promise<ThreadFollowExportPage>,
    maxBytes: number,
): Promise<{ readBytes: number; section: { follows: unknown[]; truncated: boolean } }> => {
    const follows: unknown[] = [];
    let cursor: string | undefined;
    let done = false;
    let readBytes = 0;

    while (!done && readBytes < maxBytes) {
        const page = await readPage(cursor);

        follows.push(...page.follows);
        readBytes += page.readBytes;
        cursor = page.continueCursor;
        done = cursor === undefined;
    }

    return { readBytes, section: { follows, truncated: !done } };
};
