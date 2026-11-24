/** A page of ids from a source: the ids, and where the next page starts (`null` when this was the last). */
export interface IdsPage {
    cursor: string | null;
    ids: string[];
}

/** Metadata is read this many ids at a time: one query per chunk. */
export const CHAT_FILE_METADATA_CHUNK = 100;

/**
 * The chat-file section of the export is held to this many bytes as written (indented JSON). Past it the section is cut, and says so,
 * so a large history cannot push the whole file past its cap and lose every other section.
 */
export const CHAT_FILE_EXPORT_BYTES = 8 * 1024 * 1024;

/** Walks one source to its end, returning every id it yields. */
const walkIds = async (read: (cursor: string | null) => Promise<IdsPage>): Promise<string[]> => {
    const ids: string[] = [];
    let cursor: string | null = null;
    let more = true;

    while (more) {
        const page = await read(cursor);

        ids.push(...page.ids);
        more = page.cursor !== null;
        cursor = page.cursor;
    }

    return ids;
};

/**
 * The file ids named by the messages of every thread the user owns. Threads are walked to their end; each thread's messages are
 * walked to theirs. A message keeps its files in `fileIds`, so these are the files the chats still hold. `listThreads` reads one page
 * of the owner's thread ids; `listFiles` reads one page of one thread's message file ids.
 */
export const collectAllMessageFileIds = async (
    listThreads: (cursor: string | null) => Promise<IdsPage>,
    listFiles: (threadId: string, cursor: string | null) => Promise<IdsPage>,
): Promise<string[]> => {
    const threadIds = await walkIds(listThreads);
    const ids: string[] = [];

    for (const threadId of threadIds) {
        ids.push(...(await walkIds(async (cursor) => await listFiles(threadId, cursor))));
    }

    return ids;
};

/**
 * Every chat file of one user for the export: the files behind their grants and the files their messages name, each once.
 * `listGrantedIds` reads one page of the grants; `listMessageFileIds` returns the message source (see
 * {@link collectAllMessageFileIds}); `readMetadata` reads one chunk of ids.
 *
 * Kept apart from `gdpr.ts`: the export action imports this, and the job queue is reached through `gdpr.ts`, which the mobile and
 * extension type checks do not resolve.
 */
export const collectAllChatFileMetadata = async <Row>(
    listGrantedIds: (cursor: string | null) => Promise<IdsPage>,
    listMessageFileIds: () => Promise<string[]>,
    readMetadata: (fileIds: string[]) => Promise<Row[]>,
    chunkSize: number = CHAT_FILE_METADATA_CHUNK,
): Promise<Row[]> => {
    const ids = new Set<string>(await walkIds(listGrantedIds));

    const messageIds = await listMessageFileIds();

    for (const id of messageIds) {
        ids.add(id);
    }

    const all = [...ids];
    const rows: Row[] = [];

    for (let start = 0; start < all.length; start += chunkSize) {
        rows.push(...(await readMetadata(all.slice(start, start + chunkSize))));
    }

    return rows;
};

/**
 * The rows that fit in the section's byte budget, in order, measured as the export writes them (indented JSON). Past the budget the
 * rest are left out and `truncated` says so; the caller records that in the export.
 */
export const capChatFiles = <Row>(rows: Row[], budget: number = CHAT_FILE_EXPORT_BYTES): { files: Row[]; truncated: boolean } => {
    const encoder = new TextEncoder();
    const files: Row[] = [];
    let bytes = 0;

    for (const row of rows) {
        bytes += encoder.encode(JSON.stringify(row, null, 2)).byteLength;

        if (bytes > budget) {
            return { files, truncated: true };
        }

        files.push(row);
    }

    return { files, truncated: false };
};
