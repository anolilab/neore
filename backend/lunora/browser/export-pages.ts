/**
 * The account export's walker for the browser tables (`gdpr/workflows/export-workflow.ts`), apart from `gdpr.ts` so the
 * workflow imports no query builder.
 */
import type { BrowserExportCursor } from "./gdpr";

/** One page of `gdpr.ts#collectBrowserForExport`; `next` is absent on the last. */
interface BrowserExportPage {
    actions?: unknown[];
    extensions?: unknown[];
    humanChecks?: unknown[];
    next?: BrowserExportCursor;
    sessions?: unknown[];
}

export interface BrowserExport {
    actions: unknown[];
    extensions: unknown[];
    humanChecks: unknown[];
    sessions: unknown[];
}

/**
 * Every page of the user's browser export. `readPage` runs one page as its own workflow step (given the cursor and the page
 * number, for the step's name), so no checkpoint holds more than a page.
 */
export const collectAllBrowserPages = async (readPage: (cursor: BrowserExportCursor | undefined, page: number) => Promise<unknown>): Promise<BrowserExport> => {
    const collected: BrowserExport = { actions: [], extensions: [], humanChecks: [], sessions: [] };
    let cursor: BrowserExportCursor | undefined;

    for (let page = 0; ; page += 1) {
        const result = (await readPage(cursor, page)) as BrowserExportPage;

        collected.actions.push(...(result.actions ?? []));
        collected.extensions.push(...(result.extensions ?? []));
        collected.humanChecks.push(...(result.humanChecks ?? []));
        collected.sessions.push(...(result.sessions ?? []));

        if (result.next === undefined) {
            return collected;
        }

        cursor = result.next;
    }
};
