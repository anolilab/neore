/** One page of `collectTaskSuggestionsForExport`: the rows, and where the next page starts (`null` when this was the last). */
interface TaskSuggestionsPage {
    cursor?: string | null;
    taskSuggestions?: unknown[];
}

/**
 * Walks every page of a user's task suggestions for the export workflow. `readPage` runs one page as its own
 * workflow step (given the cursor and the page number, for the step's name); a result without a cursor ends the walk.
 */
export const collectAllTaskSuggestions = async (readPage: (cursor: string | null, page: number) => Promise<unknown>): Promise<unknown[]> => {
    const taskSuggestions: unknown[] = [];
    let cursor: string | null = null;

    for (let page = 0; ; page += 1) {
        const result = (await readPage(cursor, page)) as TaskSuggestionsPage;

        taskSuggestions.push(...(result.taskSuggestions ?? []));

        if (!result.cursor) {
            return taskSuggestions;
        }

        cursor = result.cursor;
    }
};
