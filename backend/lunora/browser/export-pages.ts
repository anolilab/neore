/**
 * The account export's walker for the browser tables (`gdpr/workflows/export-workflow.ts`), apart from `gdpr.ts` so the
 * workflow imports no query builder. Each page is stored as its own object under the run's prefix, and the export file's action
 * reads them back (`gdpr/steps.ts#generateExportFile`), so no dispatch body or step result carries the whole history.
 */
import { LunoraError } from "lunorash/server";

import type { BrowserExportCursor } from "./gdpr";

export interface BrowserExport {
    actions: unknown[];
    extensions: unknown[];
    humanChecks: unknown[];
    sessions: unknown[];
}

const safe = (value: string): string => value.replaceAll(/[^\w-]/g, "_");

/** Every browser page of a user's export runs sits under this prefix, so account erasure deletes whatever a dead run left. */
export const browserExportUserPrefix = (userId: string): string => `gdpr-exports/browser-${safe(userId)}/`;

/** Where a run's browser pages are stored; one prefix per run, so the cleanup lists and deletes every page it wrote. */
export const browserExportPrefix = (userId: string, runKey: string): string => `${browserExportUserPrefix(userId)}${safe(runKey)}/`;

export const browserExportPageKey = (prefix: string, page: number): string => `${prefix}${String(page)}.json`;

/**
 * Stores every page of the user's browser export and returns how many there are. `storePage` runs one page as its own workflow
 * step (given the cursor and the page number, for the step's name and the object's key) and returns the next cursor.
 */
export const storeAllBrowserPages = async (
    storePage: (cursor: BrowserExportCursor | undefined, page: number) => Promise<{ next?: BrowserExportCursor }>,
): Promise<number> => {
    let cursor: BrowserExportCursor | undefined;

    for (let page = 0; ; page += 1) {
        const { next } = await storePage(cursor, page);

        if (next === undefined) {
            return page + 1;
        }

        cursor = next;
    }
};

/** The stored pages read back in order into one section, held to `maxBytes` in total. */
export const readAllBrowserPages = async (readPage: (page: number) => Promise<string>, pages: number, maxBytes: number): Promise<BrowserExport> => {
    const collected: BrowserExport = { actions: [], extensions: [], humanChecks: [], sessions: [] };
    let bytes = 0;

    for (let page = 0; page < pages; page += 1) {
        const text = await readPage(page);

        bytes += new TextEncoder().encode(text).byteLength;

        if (bytes > maxBytes) {
            throw new LunoraError("PAYLOAD_TOO_LARGE", "The browser history is larger than the export limit");
        }

        const result = JSON.parse(text) as Partial<BrowserExport>;

        collected.actions.push(...(result.actions ?? []));
        collected.extensions.push(...(result.extensions ?? []));
        collected.humanChecks.push(...(result.humanChecks ?? []));
        collected.sessions.push(...(result.sessions ?? []));
    }

    return collected;
};
