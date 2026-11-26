/**
 * The account export's walker for the user's task suggestions (`gdpr/workflows/export-workflow.ts`), apart from `gdpr.ts` so the
 * workflow imports no query builder. Each page is stored as its own object under the run's prefix and the export file's action
 * reads them back (`gdpr/steps.ts#generateExportFile`), so no step result or dispatch body (Lunora's 1 MiB) carries the history.
 */

/** Suggestions one stored page holds. A row can hold 20,000 characters of instructions, which JSON writes in up to 6 bytes each: 8 rows stay under 1 MiB even then. */
export const TASK_SUGGESTIONS_EXPORT_PAGE = 8;

/** The share of the export file the suggestion history may take; past it the rest is left out and the section says so. */
export const TASK_SUGGESTIONS_EXPORT_BYTES = 8 * 1024 * 1024;

/**
 * The most suggestion pages (a workflow step each) one export stores. With the browser and grant-revision pages at their own caps and
 * the export's other steps, a run stays under 1,024 steps (the lowest workflow step limit); past it the section is cut, as past its bytes.
 */
export const TASK_SUGGESTIONS_EXPORT_PAGES = 160;

/** Where page `page` of a run's suggestions is stored: under the run's browser prefix, so the run's cleanup, the sweep of a dead run and account erasure delete it with the browser pages. */
export const taskSuggestionsExportPageKey = (prefix: string, page: number): string => `${prefix}task-suggestions-${String(page)}.json`;

const ENCODER = new TextEncoder();

/** Where each row sits in the export file: `tasks.taskSuggestions[i]`, so every line of it is indented 6 spaces. */
const ROW_INDENT = 6;

/** What a page's rows take in the export file (written with a 2-space indent): each row's indented JSON, and the comma and line break after it. */
export const taskSuggestionsPageFileBytes = (rows: unknown[]): number => {
    let bytes = 0;

    for (const row of rows) {
        const text = JSON.stringify(row, null, 2);

        bytes += ENCODER.encode(text).byteLength + text.split("\n").length * ROW_INDENT + 2;
    }

    return bytes;
};

/**
 * Stores the pages of the user's suggestions, at most {@link TASK_SUGGESTIONS_EXPORT_PAGES} and {@link TASK_SUGGESTIONS_EXPORT_BYTES} in the
 * export file, and returns how many to read back and whether the history went on past them. `storePage` runs one page as its own workflow
 * step (given the cursor and the page number, for the step's name and the object's key) and returns the next cursor and the page's size in
 * the file. A page that would pass the bytes is not counted, and no page is stored after it.
 */
export const storeAllTaskSuggestionPages = async (
    storePage: (cursor: string | undefined, page: number) => Promise<{ bytes?: number; next?: string }>,
): Promise<{ cut: boolean; pages: number }> => {
    let cursor: string | undefined;
    let total = 0;

    for (let page = 0; ; page += 1) {
        const { bytes = 0, next } = await storePage(cursor, page);

        total += bytes;

        if (total > TASK_SUGGESTIONS_EXPORT_BYTES) {
            return { cut: true, pages: page };
        }

        if (next === undefined || page + 1 >= TASK_SUGGESTIONS_EXPORT_PAGES) {
            return { cut: next !== undefined, pages: page + 1 };
        }

        cursor = next;
    }
};

/**
 * The stored pages read back in order into one section, held to `maxBytes` in the export file: the first page past it, and every one
 * after, is left out and the section is marked cut, so the rest of the export is still written. `cut`: the pages were cut already.
 */
export const readAllTaskSuggestionPages = async (
    readPage: (page: number) => Promise<string>,
    pages: number,
    maxBytes: number,
    cut = false,
): Promise<{ cut: boolean; taskSuggestions: unknown[] }> => {
    const taskSuggestions: unknown[] = [];
    let bytes = 0;

    for (let page = 0; page < pages; page += 1) {
        const rows = (JSON.parse(await readPage(page)) as { taskSuggestions?: unknown[] }).taskSuggestions ?? [];

        bytes += taskSuggestionsPageFileBytes(rows);

        if (bytes > maxBytes) {
            return { cut: true, taskSuggestions };
        }

        taskSuggestions.push(...rows);
    }

    return { cut, taskSuggestions };
};
