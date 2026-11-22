/**
 * The account export's walker for the browser tables (`gdpr/workflows/export-workflow.ts`), apart from `gdpr.ts` so the
 * workflow imports no query builder. Each page is stored as its own object under the run's prefix, and the export file's action
 * reads them back (`gdpr/steps.ts#generateExportFile`), so no dispatch body or step result carries the whole history.
 */
import type { BrowserExportCursor } from "./gdpr";

export interface BrowserExport {
    actions: unknown[];
    extensions: unknown[];
    humanChecks: unknown[];
    sessions: unknown[];
    /** The history passed {@link BROWSER_EXPORT_BYTES} or {@link BROWSER_EXPORT_PAGES}: every row after the last one here is left out. */
    truncated?: true;
}

/** The share of the export file the browser history may take; past it, the rest is left out and the section says so. */
export const BROWSER_EXPORT_BYTES = 8 * 1024 * 1024;

/**
 * The most browser pages (a workflow step each) one export stores, far under a workflow's step limit (`@lunora/workflow`'s
 * `limits.steps`, 10,000 by default) with the export's other steps besides; past it the section is cut, as past its bytes.
 */
export const BROWSER_EXPORT_PAGES = 256;

/**
 * One key segment from an id: `encodeURIComponent` is injective (`%` itself becomes `%25`, and `/` is escaped), so two ids never share
 * a segment, and one user's erasure or one run's cleanup never reaches another's pages. A lossy substitution (`user/a`, `user_a`) did.
 */
const segment = (value: string): string => encodeURIComponent(value);

/** Every browser page of a user's export runs sits under this prefix, so account erasure deletes whatever a dead run left. */
export const browserExportUserPrefix = (userId: string): string => `gdpr-exports/browser-${segment(userId)}/`;

/** Where a run's browser pages are stored; one prefix per run, so the cleanup lists and deletes every page it wrote. */
export const browserExportPrefix = (userId: string, runKey: string): string => `${browserExportUserPrefix(userId)}${segment(runKey)}/`;

export const browserExportPageKey = (prefix: string, page: number): string => `${prefix}${String(page)}.json`;

const ENCODER = new TextEncoder();

/** Where each row sits in the export file (`gdpr/steps.ts#generateExportFile`): `browser.<list>[i]`, so every line of it is indented 6 spaces. */
const ROW_INDENT = 6;

/**
 * What a page's rows take in the export file, which is written with a 2-space indent: each row's indented JSON, every line of it
 * at {@link ROW_INDENT}, and the comma and line break after it. Measured where the page is stored and again where it is read back,
 * so both stop at the same page.
 */
export const browserPageFileBytes = (page: Partial<BrowserExport>): number => {
    const rows = [...(page.actions ?? []), ...(page.extensions ?? []), ...(page.humanChecks ?? []), ...(page.sessions ?? [])];
    let bytes = 0;

    for (const row of rows) {
        const text = JSON.stringify(row, null, 2);

        bytes += ENCODER.encode(text).byteLength + text.split("\n").length * ROW_INDENT + 2;
    }

    return bytes;
};

/**
 * Stores the pages of the user's browser export, at most {@link BROWSER_EXPORT_PAGES} and {@link BROWSER_EXPORT_BYTES} in the export
 * file, and returns how many to read back and whether the history went on past them. `storePage` runs one page as its own workflow
 * step (given the cursor and the page number, for the step's name and the object's key) and returns the next cursor and the page's
 * size in the file ({@link browserPageFileBytes}). A page that would pass the bytes is not counted, and no page is stored after it.
 */
export const storeAllBrowserPages = async (
    storePage: (cursor: BrowserExportCursor | undefined, page: number) => Promise<{ bytes?: number; next?: BrowserExportCursor }>,
): Promise<{ cut: boolean; pages: number }> => {
    let cursor: BrowserExportCursor | undefined;
    let total = 0;

    for (let page = 0; ; page += 1) {
        const { bytes = 0, next } = await storePage(cursor, page);

        total += bytes;

        if (total > BROWSER_EXPORT_BYTES) {
            return { cut: true, pages: page };
        }

        if (next === undefined || page + 1 >= BROWSER_EXPORT_PAGES) {
            return { cut: next !== undefined, pages: page + 1 };
        }

        cursor = next;
    }
};

/**
 * The stored pages read back in order into one section, held to `maxBytes` in the export file ({@link browserPageFileBytes}): the
 * first page past it, and every one after, is left out and the section is marked `truncated`, so the rest of the export is still
 * written. `cut`: the pages were cut already.
 */
export const readAllBrowserPages = async (
    readPage: (page: number) => Promise<string>,
    pages: number,
    maxBytes: number,
    cut = false,
): Promise<BrowserExport> => {
    const collected: BrowserExport = { actions: [], extensions: [], humanChecks: [], sessions: [], ...(cut && { truncated: true as const }) };
    let bytes = 0;

    for (let page = 0; page < pages; page += 1) {
        const result = JSON.parse(await readPage(page)) as Partial<BrowserExport>;

        bytes += browserPageFileBytes(result);

        if (bytes > maxBytes) {
            return { ...collected, truncated: true };
        }

        collected.actions.push(...(result.actions ?? []));
        collected.extensions.push(...(result.extensions ?? []));
        collected.humanChecks.push(...(result.humanChecks ?? []));
        collected.sessions.push(...(result.sessions ?? []));
    }

    return collected;
};
