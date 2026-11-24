/** Chat-file ids per page: the source's ids and where the next page starts (`null` when this was the last). */
export interface ChatFileIdsPage {
    cursor: string | null;
    fileIds: string[];
}

/** The two sources a user's chat files come from (`collectChatFileIdsForExport`). */
export type ChatFileSource = "grants" | "threads";

/** Metadata is read this many ids at a time: one query per chunk. */
export const CHAT_FILE_METADATA_CHUNK = 100;

/**
 * Every chat file of one user for the export: the files behind their grants and behind the links of their own chats, each once.
 * `listIds` reads one page of a source; each source is walked to its end before the next. `readMetadata` reads one chunk of ids.
 *
 * Kept apart from `gdpr.ts`: the export action imports this, and the job queue is reached through `gdpr.ts`, which the mobile and
 * extension type checks do not resolve.
 */
export const collectAllChatFileMetadata = async <Row>(
    listIds: (source: ChatFileSource, cursor: string | null) => Promise<ChatFileIdsPage>,
    readMetadata: (fileIds: string[]) => Promise<Row[]>,
    chunkSize: number = CHAT_FILE_METADATA_CHUNK,
): Promise<Row[]> => {
    const ids = new Set<string>();

    for (const source of ["grants", "threads"] as const) {
        let cursor: string | null = null;
        let more = true;

        while (more) {
            const page = await listIds(source, cursor);

            for (const id of page.fileIds) {
                ids.add(id);
            }

            more = page.cursor !== null;
            cursor = page.cursor;
        }
    }

    const all = [...ids];
    const rows: Row[] = [];

    for (let start = 0; start < all.length; start += chunkSize) {
        rows.push(...(await readMetadata(all.slice(start, start + chunkSize))));
    }

    return rows;
};
