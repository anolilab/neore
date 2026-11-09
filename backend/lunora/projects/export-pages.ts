import { LunoraError } from "lunorash/server";

/** One page of `collectProjectRepositoriesForExport`: its rows, and where the next page starts (`null` after the last). */
interface RepositoriesPage {
    cursor?: string | null;
    projectRepositories?: unknown[];
}

/**
 * Walks every page of a user's repository rows for the export file, one query per page, and reports done only after
 * the last page. A row is never left out: past `maxBytes` (counted in UTF-8, as the file is stored) the walk stops with
 * PAYLOAD_TOO_LARGE rather than return a cut list.
 */
export const collectAllRepositories = async (
    readPage: (cursor: string | null) => Promise<unknown>,
    maxBytes: number,
): Promise<{ projectRepositories: unknown[] }> => {
    const projectRepositories: unknown[] = [];
    let cursor: string | null = null;
    let bytes = 0;

    for (;;) {
        const result = (await readPage(cursor)) as RepositoriesPage;

        bytes += new TextEncoder().encode(JSON.stringify(result)).byteLength;

        if (bytes > maxBytes) {
            throw new LunoraError("PAYLOAD_TOO_LARGE", "The project repositories are larger than the export limit");
        }

        projectRepositories.push(...(result.projectRepositories ?? []));

        if (!result.cursor) {
            return { projectRepositories };
        }

        cursor = result.cursor;
    }
};
